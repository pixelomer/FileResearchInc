// Number of seconds for a bit window.
//
// The result of dividing 3600 by this number should be an even number.
// If you change this number while uploading, you must also use the
// same value for downloading.
const BIT_WINDOW = 120;

// Maximum number of connections during upload.
//
// Higher number means more bits per second, but also higher risk of
// unintentional bit flips and rate limit errors.
const UPLOAD_CONNECTION_COUNT = 8;

// Maximum number of connections during download.
const DOWNLOAD_CONNECTION_COUNT = 8;

// Number of seconds to wait between BIT_WINDOW-second upload windows.
// 
// Uploading works by continuously switching between writing ones and
// writing zeroes every BIT_WINDOW seconds. Writing a bit towards the end of a
// bit window carries the risk of permanently writing an incorrect bit and
// corrupting the upload. This option configures how many seconds the script
// should wait before switching from writing ones/zeroes to zeroes/ones. A higher
// number is safer but slower. A lower number is faster but more likely to cause
// corruption. This number must be in the range [0, BIT_WINDOW-1]. A higher number
// is recommended if the server is slow at responding due to high load.
const UPLOAD_BIT_FLIP_GAP = 20;

// Configures the amount of time (in ms) to sleep before continuing after
// receiving an error response from the server.
const RATE_LIMIT_DURATION = 3000;

export interface BitData {
    value: 0 | 1,
    date: Date,
    isNew: boolean
};

export function keygen(): bigint {
    const BITS = 64;
    const ELEMSIZE = 32;
    const LEN = BITS / ELEMSIZE;
    const buf = new globalThis[`Uint${ELEMSIZE}Array`](LEN);
    crypto.getRandomValues(buf);
    let val = 0n;
    for (let i=0; i<LEN; ++i) {
        val += BigInt(buf[i]) * (2n ** BigInt(ELEMSIZE * i))
    }
    return val;
}

export function getTime(date?: Date): number {
    if (date == null) {
        date = new Date();
    }
    return date.getUTCMinutes() * 60 + date.getUTCSeconds();
}

export function bitForDate(date?: Date): 0 | 1 {
    return (getTime(date) % (BIT_WINDOW * 2) >= BIT_WINDOW) ? 1 : 0;
}

export function currentBit(): 0 | 1 {
    return bitForDate(new Date());
}

function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
}

export function isSafeToWrite() {
    return getTime() % BIT_WINDOW <= (BIT_WINDOW - UPLOAD_BIT_FLIP_GAP - 1);
}

export async function waitUntilSafeWrite() {
    while (!isSafeToWrite()) {
        await sleep(100);
    }
}

export async function tryFetchBit(id: bigint): Promise<BitData | null> {
    let bit: number | null = null;
    let date: Date | null = null;
    let isNew: boolean | null = null;
    //console.log("fetching bit:", id);
    while (bit == null) {
        try {
            const res = await fetch("https://numberresearch.xyz/api/check", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ number: id.toString() })
            });
            const json = await res.json();
            if (!res.ok) {
                console.error("\nHTTP", res.status);
                console.error(json);
            }
            else {
                date = new Date(json.discovered_at);
                bit = bitForDate(date);
                isNew = json.is_new;
            }
        }
        catch (err) {
            console.error();
            console.error(err);
        }
        if (bit == null) {
            return null;
        }
    }
    return { value: bit as (0 | 1), date: date!, isNew: isNew! };
}

export async function fetchBit(id: bigint): Promise<BitData> {
    let data: BitData | null = null;
    while (data == null) {
        data = await tryFetchBit(id);
        if (data == null) {
            await sleep(RATE_LIMIT_DURATION);
        }
    }
    return data;
}

export async function upload(key: bigint, path: string) {
    const base = key << 32n;
    const file = await Deno.open(path, { read: true });
    const ones = new Set<number>();
    const zeroes = new Set<number>();
    let bitId = 0;
    let wrote = 0;
    let activeDownloads = 0;
    let errors = 0;
    const promises: Promise<void>[] = [];
    const intervalCb = async() => {
        const date = new Date();
        const timestamp = date.getUTCHours().toString().padStart(2, "0") + ":" +
            date.getUTCMinutes().toString().padStart(2, "0") + ":" +
            date.getUTCSeconds().toString().padStart(2, "0");
        const text = `\rwrote ${wrote} bits (= ${(wrote/8).toFixed(3)} bytes, ` +
            `${activeDownloads} conns, ${errors} errors, ${timestamp}, ` +
            `bit ${currentBit()}, safe? ${isSafeToWrite() ? "yes": " no"})`
        await Deno.stderr.write(new TextEncoder().encode(text));
    };
    const interval = setInterval(intervalCb, 250);
    for await (const chunk of file.readable) {
        for (let i=0; i<chunk.length; ++i) {
            let byte = chunk[i];
            for (let j=0; j<8; ++j) {
                if ((byte & 1) === 0) {
                    zeroes.add(bitId);
                }
                else {
                    ones.add(bitId);
                }
                byte >>= 1;
                ++bitId;
            }
        }
        while (ones.size > 0 || zeroes.size > 0) {
            const cb = async(): Promise<void> => {
                await waitUntilSafeWrite();
                const bit = currentBit();
                const set = (bit === 1) ? ones : zeroes;
                if (set.size > 0) {
                    const bitIndex = set.values().next().value as number;
                    set.delete(bitIndex);
                    ++activeDownloads;
                    const actualBitData = await tryFetchBit(base + BigInt(bitIndex));
                    if (actualBitData == null) {
                        set.add(bitIndex);
                        await sleep(RATE_LIMIT_DURATION);
                        promises.splice(promises.indexOf(promise), 1);
                        --activeDownloads;
                        return;
                    }
                    const actualBit = actualBitData.value;
                    if (actualBit !== bit) {
                        console.error(`ERROR: for bit ${bitIndex}, tried to write ` +
                            `${bit} but wrote ${actualBit}`);
                        ++errors;
                    }
                    ++wrote;
                    --activeDownloads;
                }
                else {
                    await sleep(1000);
                }
                promises.splice(promises.indexOf(promise), 1);
            };
            const promise = cb();
            promises.push(promise);
            if (promises.length >= UPLOAD_CONNECTION_COUNT) {
                await Promise.any([...promises]);
            }
        }
        await Promise.all([...promises]);
    }
    clearInterval(interval);
    await intervalCb();
    console.error();
    
    // upload completion timestamp
    await fetchBit(base-1n);
}

export async function download(key: bigint, writable: WritableStream) {
    const base = key << 32n;
    const promises: Promise<void>[] = [];
    const writer = writable.getWriter();
    let bitCount = 0;
    let lastIndex = Number.MAX_SAFE_INTEGER;
    const intervalCb = async() => {
        const text = `\rread ${bitCount} bits (= ${(bitCount/8).toFixed(3)} bytes)`
        await Deno.stderr.write(new TextEncoder().encode(text));
    };
    const interval = setInterval(intervalCb, 250);
    const completionTimestamp = (await fetchBit(base-1n)).date;
    const data: number[] = [];
    for (let i=0; i<lastIndex; ++i) {
        const cb = async(): Promise<void> => {
            const bit = await fetchBit(base + BigInt(i));
            if (bit.date.valueOf() > completionTimestamp.valueOf() || bit.isNew) {
                lastIndex = Math.min(lastIndex, i);
            }
            else {
                if (data[Math.floor(i / 8)] == null) {
                    data[Math.floor(i / 8)] = 0;
                }
                data[Math.floor(i / 8)] |= bit.value << (i % 8);
                ++bitCount;
                promises.splice(promises.indexOf(promise), 1);
            }
        };
        const promise = cb();
        promises.push(promise);
        if (promises.length >= DOWNLOAD_CONNECTION_COUNT) {
            await Promise.any([...promises]);
        }
    }
    await Promise.all([...promises]);
    await writer.write(new Uint8Array(data));
    writer.close();
    clearInterval(interval);
    await intervalCb();
    console.error();
}
