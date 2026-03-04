#!/usr/bin/env -S deno run --allow-net=numberresearch.xyz

import * as FileResearchInc from "./mod.ts";

const path = Deno.args[0];

if (path == null) {
    console.error("usage: upload.ts <path>");
    Deno.exit(1);
}

const key = FileResearchInc.keygen();
console.error("uploading with key:", key.toString(16).toUpperCase());
await FileResearchInc.upload(key, path);
