// const http = require("http");
import http from "http";
import url from "url";
import { getWindowContents } from "./renderer-window";

export function createServer(portnumber: number) {
  // Create a simple HTTP server
  const server = http.createServer(
    (req: http.IncomingMessage, res: http.ServerResponse) => {
      // Respond to all GET requests with a simple message
      if (req.method === "GET") {
        const parsedUrl = url.parse(req.url);

        if (parsedUrl.href == "/favicon.ico") {
          res.writeHead(404);
          res.end("");
          return;
        }

        if (parsedUrl.href == "/SDL_assert") {
          getWindowContents().send("play-sound", "audio 1");
        }

        if (parsedUrl.href == "/DOCTEST") {
          getWindowContents().send("play-sound", "audio 3");
        }

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Hello from Electron's Main Process!");
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
