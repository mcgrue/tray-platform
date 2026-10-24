$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $logsPath = Join-Path $request.codexHome 'logs_2.sqlite'
    $statePath = Join-Path $request.codexHome 'state_5.sqlite'
    if (-not (Test-Path -LiteralPath $logsPath -PathType Leaf) -or -not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw 'Codex activity databases are unavailable.'
    }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CodexActivitySqlite {
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_open_v2(byte[] file, out IntPtr db, int flags, IntPtr vfs);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_close(IntPtr db);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_busy_timeout(IntPtr db, int milliseconds);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int length, out IntPtr statement, IntPtr tail);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_step(IntPtr statement);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_finalize(IntPtr statement);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr sqlite3_column_text(IntPtr statement, int column);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_column_bytes(IntPtr statement, int column);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)] static extern double sqlite3_column_double(IntPtr statement, int column);

    static byte[] Utf8(string text) { return Encoding.UTF8.GetBytes(text + "\0"); }
    static string Text(IntPtr statement, int column) {
        int size = sqlite3_column_bytes(statement, column);
        if (size > 32768) throw new Exception("Codex activity field is too large.");
        byte[] bytes = new byte[size];
        if (size > 0) Marshal.Copy(sqlite3_column_text(statement, column), bytes, 0, size);
        return Encoding.UTF8.GetString(bytes);
    }
    static IntPtr Prepare(IntPtr db, string sql) {
        IntPtr statement;
        if (sqlite3_prepare_v2(db, Utf8(sql), -1, out statement, IntPtr.Zero) != 0)
            throw new Exception("Codex activity schema is unavailable.");
        return statement;
    }
    static void Execute(IntPtr db, string sql) {
        IntPtr statement = Prepare(db, sql);
        try { if (sqlite3_step(statement) != 101) throw new Exception("Cannot read Codex activity."); }
        finally { sqlite3_finalize(statement); }
    }
    public static List<Dictionary<string, object>> Read(string logs, string state, long since, bool includeSubmissions) {
        IntPtr db = IntPtr.Zero;
        try {
            // SQLITE_OPEN_READONLY | SQLITE_OPEN_URI. Attached state DB is also read-only.
            if (sqlite3_open_v2(Utf8(new Uri(logs).AbsoluteUri + "?mode=ro"), out db, 0x41, IntPtr.Zero) != 0)
                throw new Exception("Cannot open Codex activity read-only.");
            sqlite3_busy_timeout(db, 1000);
            Execute(db, "ATTACH DATABASE '" + (new Uri(state).AbsoluteUri + "?mode=ro").Replace("'", "''") + "' AS state");
            // Execution spans identify the process, unlike UI broadcasts. Activity
            // also includes admitted turns that have not reached their first sample.
            string sampling = "instr(feedback_log_body, 'run_sampling_request{turn_id=') > 0";
            string submission = "instr(feedback_log_body, 'submission_dispatch{otel.name=\"op.dispatch.turn_input\" submission.id=\"') > 0";
            string sql = @"SELECT process_uuid, thread_id,
                CASE WHEN " + sampling + @" THEN
                  substr(feedback_log_body, instr(feedback_log_body, 'run_sampling_request{turn_id=') + length('run_sampling_request{turn_id='), 36)
                ELSE substr(feedback_log_body, instr(feedback_log_body, 'submission.id=""') + length('submission.id=""'), 36) END AS turn_id,
                min(ts * 1000.0 + ts_nanos / 1000000.0), max(ts * 1000.0 + ts_nanos / 1000000.0), threads.rollout_path
                FROM logs JOIN state.threads ON threads.id = logs.thread_id
                WHERE ts >= " + since.ToString(System.Globalization.CultureInfo.InvariantCulture) + @"
                AND (" + sampling + (includeSubmissions ? " OR " + submission : "") + @")
                GROUP BY process_uuid, thread_id, turn_id, threads.rollout_path
                ORDER BY max(ts) DESC LIMIT 20001";
            IntPtr statement = Prepare(db, sql);
            try {
                var rows = new List<Dictionary<string, object>>();
                int code;
                while ((code = sqlite3_step(statement)) == 100) {
                    if (rows.Count >= 20000) throw new Exception("Codex activity scan limit reached.");
                    rows.Add(new Dictionary<string, object> {
                        { "processIdentity", Text(statement, 0) }, { "threadId", Text(statement, 1) },
                        { "turnId", Text(statement, 2) }, { "firstObservedAt", sqlite3_column_double(statement, 3) },
                        { "lastObservedAt", sqlite3_column_double(statement, 4) }, { "rolloutPath", Text(statement, 5) }
                    });
                }
                if (code != 101) throw new Exception("Cannot read Codex activity.");
                return rows;
            } finally { sqlite3_finalize(statement); }
        } finally { if (db != IntPtr.Zero) sqlite3_close(db); }
    }
}
'@
    $rows = [CodexActivitySqlite]::Read($logsPath, $statePath, [long]$request.sinceSeconds, [bool]$request.includeSubmissions)
    @{ ok = $true; result = @($rows.ToArray()) } | ConvertTo-Json -Compress -Depth 5
} catch {
    @{ ok = $false; error = 'Codex edit history is unavailable.' } | ConvertTo-Json -Compress
}
