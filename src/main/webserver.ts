import { getWindowContents } from "./renderer-window";
import http from "http";

import url from "url";

export function createServer(portnumber: number) {
  // Create a simple HTTP server
  const server = http.createServer(
    (req: http.IncomingMessage, res: http.ServerResponse) => {
      // Respond to all GET requests with a simple message
      if (req.method === "GET") {
        const parsedUrl = url.parse(req.url!, true);
        const queryParams = parsedUrl.query;
        const queryParamsDict: { [key: string]: string } = {};
        for (const key in queryParams) {
          if (Object.prototype.hasOwnProperty.call(queryParams, key)) {
            queryParamsDict[key] = queryParams[key] as string;
          }
        }

        if (parsedUrl.href == "/favicon.ico") {
          res.writeHead(404);
          res.end("");
          return;
        }

        if (queryParamsDict.say) {
          getWindowContents().send("say-words", queryParamsDict.say);
        }

        if (parsedUrl.href == "/SDL_assert") {
          getWindowContents().send("play-sound", "audio 1");
        }

        if (parsedUrl.href == "/DOCTEST_ALL_TESTS_PASS") {
          getWindowContents().send("play-sound", "audio 2");
        }

        if (parsedUrl.href == "/DOCTEST_ASSERT_FAIL") {
          getWindowContents().send("play-sound", "audio 3");
        }

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Hello from Electron's Main Process?");
      }
    },
  );

  server.listen(portnumber, () => {
    console.log(`Server listening on port ${portnumber}`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.log(`Port ${portnumber} is already in use.`);
      // Here you could attempt to find and kill the process using the port
    }
    console.error(`Server Error: ${error}`);
    console.error(error);
  });

  return server;
}
