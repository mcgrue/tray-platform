# Get the directory of the PowerShell script
$scriptDirectory = $PSScriptRoot

# Combine with the relative path to the directory to watch
$directoryToWatch = Join-Path -Path $scriptDirectory -ChildPath "..\src"

function global:ExecuteYarnCommand {
    $command = "yarn pre-build"

    # Create a new process with a clean environment
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = "powershell"
    $startInfo.Arguments = "-Command $command"
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.UseShellExecute = $false
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    
    # Start the process
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $process.Start() | Out-Null
    
    # Capture output
    $output = $process.StandardOutput.ReadToEnd()
    $error_ = $process.StandardError.ReadToEnd()
    
    # Wait for the process to finish
    $process.WaitForExit()

    if ($output -ne $null -and $output -ne "") {
        Write-Host $output -ForegroundColor Green
    } else {
        Write-Host "No yarn output?" -ForegroundColor Green
    }
    if ($error_ -ne $null -and $error_ -ne "") {
        Write-Host $error_ -ForegroundColor Magenta
    }
}



# Create a file system watcher
$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $directoryToWatch
$watcher.IncludeSubdirectories = $true
$watcher.EnableRaisingEvents = $true

$global:lastActionTime = [datetime]::MinValue

# Define the event action
$action = {
    # debounce 1s
    $now = [datetime]::UtcNow
    $timeSinceLastExecution = $now - $global:lastActionTime
    if ($timeSinceLastExecution.TotalMilliseconds -lt 1000) {
        # If yes, return early without executing the command
        return
    } else {
        #Write-Host $now
        #Write-Host $global:lastActionTime
        #Write-Host $timeSinceLastExecution
        #Write-Host $timeSinceLastExecution.TotalMilliseconds

        # Update the last action execution time
        $global:lastActionTime = $now
    }
    

    $greyColor = [char]27 + '[38;5;211m'
    $resetColor = [char]27 + '[0m'
    Write-Host "${greyColor} File $($Event.SourceEventArgs.FullPath) $($Event.SourceEventArgs.ChangeType) $_${resetColor}"
    try {
        ExecuteYarnCommand
    } catch {
        $orangeColor = [char]27 + '[38;5;208m'
        
        Write-Host "${orangeColor}Error executing Yarn command: $_${resetColor}"
    }
}

# Register events
$changedEvent = Register-ObjectEvent $watcher "Changed" -Action $action
$createdEvent = Register-ObjectEvent $watcher "Created" -Action $action
$deletedEvent = Register-ObjectEvent $watcher "Deleted" -Action $action
$renamedEvent = Register-ObjectEvent $watcher "Renamed" -Action $action

Write-Host "Watching directory $directoryToWatch for changes..."
try {
    do {
        Wait-Event -Timeout 60
    } while (1) # 27 is the virtual key code for ESC
} finally {
    # Cleanup
    Unregister-Event -SubscriptionId $changedEvent.Id
    Unregister-Event -SubscriptionId $createdEvent.Id
    Unregister-Event -SubscriptionId $deletedEvent.Id
    Unregister-Event -SubscriptionId $renamedEvent.Id
    $watcher.EnableRaisingEvents = $false
    $watcher.Dispose()

    Write-Host "Watcher stopped."
}

