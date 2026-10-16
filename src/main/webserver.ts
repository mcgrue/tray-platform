import http from "http";
import url from "url";
import soundConfig from "../shared/sounds.json";
import { SoundConfig } from "../shared/types";
import { getWindowContents } from "./renderer-window";

const sounds = (soundConfig as SoundConfig).sounds;

interface ServerOptions {
  apiHandler?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<boolean>;
  playSound?: (id: string) => void;
  sayWords?: (text: string) => void;
}

export function createServer(portnumber: number, options: ServerOptions = {}) {
  const playSound =
    options.playSound ||
    ((id: string) => getWindowContents().send("play-sound", id));
  const sayWords =
    options.sayWords ||
    ((text: string) => getWindowContents().send("say-words", text));
  const server = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      try {
        if (options.apiHandler && (await options.apiHandler(req, res))) return;
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
            sayWords(queryParamsDict.say);
          }

          // Map endpoints to sound IDs
          const endpointToSound = Object.entries(sounds).reduce(
            (acc, [_, sound]) => {
              sound.endpoints.forEach((endpoint) => {
                acc[endpoint] = sound.id;
              });
              return acc;
            },
            {} as { [key: string]: string },
          );

          const soundId = endpointToSound[parsedUrl.pathname!];
          if (soundId) {
            playSound(soundId);
          }

          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("Hello from Electron's Main Process!");
        } else {
          res.writeHead(405, { Allow: "GET" });
          res.end("Method not allowed");
        }
      } catch (error) {
        console.error("Request failed:", error);
        if (!res.headersSent)
          res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Request failed");
      }
    },
  );

  server.listen(portnumber, () => {
    console.log(`Server listening on port ${portnumber}`);
  });

  server.on("error", (error) => {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.log(`Port ${portnumber} is already in use.`);
    }
    console.error(`Server Error: ${error}`);
  });

  return server;
}
