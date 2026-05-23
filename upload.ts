#!/usr/bin/env -S deno run --allow-net --allow-read=proxies.txt~,proxies.txt --allow-write=proxies.txt~,proxies.txt --allow-env=FILE_RESEARCH_USE_PROXY

import * as FileResearchInc from "./mod.ts";

const path = Deno.args[0];

if (path == null) {
    console.error("usage: upload.ts <path>");
    Deno.exit(1);
}

const key = FileResearchInc.keygen();
console.error("uploading with key:", key.toString(16).toUpperCase());
await FileResearchInc.upload(key, path);
console.error("upload completed:", key.toString(16).toUpperCase());
Deno.exit(0);
