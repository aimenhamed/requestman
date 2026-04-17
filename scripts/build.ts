import { buildClient } from "../src/build-client";

await buildClient(true);
console.log("Built client bundle to dist/");
