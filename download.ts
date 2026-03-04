#!/usr/bin/env -S deno run --allow-net

import * as FileResearchInc from "./mod.ts";

const path = Deno.args[1];
const keyStr = Deno.args[0];

if (path == null || keyStr == null) {
    console.error("usage: download.ts <key> <path>");
    Deno.exit(1);
}

const key = BigInt(`0x${keyStr}`);
console.error("downloading with key:", key.toString(16));
const outfile = await Deno.open(path, { write: true, create: true });
await FileResearchInc.download(key, outfile.writable);
console.error("download completed:", key.toString(16).toUpperCase());
