// Number of seconds for a nibble window.
const NIBBLE_WINDOW = 20;

// Maximum number of connections during upload. Higher number means
// more nibbles per second, but also higher risk of corruption and
// rate limit errors.
const UPLOAD_CONNECTION_COUNT = 8;

// Maximum number of connections during download.
const DOWNLOAD_CONNECTION_COUNT = 8;

// Number of seconds to sleep towards the end of each upload window.
const UPLOAD_WINDOW_GAP = 5;

// Configures the amount of time (in ms) to sleep before continuing after
// receiving an error response from the server.
const RATE_LIMIT_DURATION = 15000;

export type Nibble = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

export interface NibbleData {
    value: Nibble,
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
    return date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();
}

export function nibbleForDate(date?: Date): Nibble {
    return Math.floor((getTime(date) % (NIBBLE_WINDOW * 16)) / NIBBLE_WINDOW) as Nibble;
}

export function currentNibble(): Nibble {
    return nibbleForDate(new Date());
}

function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
}

export function isSafeToWrite() {
    return getTime() % NIBBLE_WINDOW <= (NIBBLE_WINDOW - UPLOAD_WINDOW_GAP - 1);
}

export async function waitUntilSafeWrite() {
    while (!isSafeToWrite()) {
        await sleep(100);
    }
}

export async function tryFetchNibble(id: bigint): Promise<NibbleData | null> {
    const data = {} as NibbleData;
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
            if (res.status !== 429) {
                console.error("\nHTTP", res.status);
                console.error(json);
            }
        }
        else {
            data.date = new Date(json.discovered_at);
            data.value = nibbleForDate(data.date);
            data.isNew = json.is_new;
        }
    }
    catch (err) {
        console.error();
        console.error(err);
    }
    if (data.value == null) {
        return null;
    }
    return data;
}

export async function fetchNibble(id: bigint): Promise<NibbleData> {
    let data: NibbleData | null = null;
    while (data == null) {
        data = await tryFetchNibble(id);
        if (data == null) {
            await sleep(RATE_LIMIT_DURATION);
        }
    }
    return data;
}

export async function upload(key: bigint, path: string) {
    const base = key << 32n;
    const file = await Deno.open(path, { read: true });
    const queued = [] as unknown as Record<Nibble, Set<number>>;
    const done = () => !(queued as unknown as Set<number>[]).some((s) => s.size > 0);
    let nextNibIdx = 0;
    let wrote = 0;
    let activeDownloads = 0;
    let errors = 0;
    const promises: Promise<void>[] = [];
    const intervalCb = async() => {
        const date = new Date();
        const timestamp = date.getUTCHours().toString().padStart(2, "0") + ":" +
            date.getUTCMinutes().toString().padStart(2, "0") + ":" +
            date.getUTCSeconds().toString().padStart(2, "0");
        const text = `\rwrote ${wrote} nibs (= ${(wrote/2).toFixed(1)} bytes, ` +
            `${activeDownloads} conns, ${errors} errors, ${timestamp}, ` +
            `nib ${currentNibble().toString(16).toUpperCase()}, safe? ${isSafeToWrite() ? "yes": " no"})`
        await Deno.stderr.write(new TextEncoder().encode(text));
    };
    const interval = setInterval(intervalCb, 250);
    for (let i=0; i<16; ++i) {
        queued[i as Nibble] = new Set();
    }
    //FIXME: this is not memory-efficient but realistically it doesn't make
    //       any sense to use this tool for anything exceeding 1 KiB so whatever
    for await (const chunk of file.readable) {
        for (let i=0; i<chunk.length; ++i) {
            let byte = chunk[i];
            for (let j=0; j<2; ++j) {
                const nibble = (byte & 0xF) as Nibble;
                queued[nibble].add(nextNibIdx);
                byte >>= 4;
                ++nextNibIdx;
            }
        }
    }
    while (!done()) {
        const cb = async(): Promise<void> => {
            await waitUntilSafeWrite();
            const nib = currentNibble();
            const set = queued[nib];
            if (set.size > 0) {
                const nibIdx = set.values().next().value as number;
                set.delete(nibIdx);
                ++activeDownloads;
                const actualNibData = await tryFetchNibble(base + BigInt(nibIdx));
                if (actualNibData == null) {
                    set.add(nibIdx);
                    await sleep(RATE_LIMIT_DURATION);
                    promises.splice(promises.indexOf(promise), 1);
                    --activeDownloads;
                    return;
                }
                const actualNib = actualNibData.value;
                if (actualNib !== nib) {
                    console.error(`ERROR: for nibble ${nibIdx}, tried to write ` +
                        `${nib.toString(16).toUpperCase()} but wrote ${actualNib.toString(16).toUpperCase()}`);
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
    clearInterval(interval);
    await intervalCb();
    console.error();
    
    // upload completion timestamp
    await fetchNibble(base-1n);
}

export async function download(key: bigint, writable: WritableStream) {
    const base = key << 32n;
    const promises: Promise<void>[] = [];
    const writer = writable.getWriter();
    let nibCount = 0;
    let lastIndex = Number.MAX_SAFE_INTEGER;
    const intervalCb = async() => {
        const text = `\rread ${nibCount} nibs (= ${(nibCount/2).toFixed(1)} bytes)`
        await Deno.stderr.write(new TextEncoder().encode(text));
    };
    const interval = setInterval(intervalCb, 250);
    const completionTimestamp = (await fetchNibble(base-1n)).date;
    const data: number[] = [];
    for (let i=0; i<lastIndex; ++i) {
        const cb = async(): Promise<void> => {
            const nibData = await fetchNibble(base + BigInt(i));
            if (nibData.date.valueOf() > completionTimestamp.valueOf() || nibData.isNew) {
                lastIndex = Math.min(lastIndex, i);
            }
            else {
                if (data[Math.floor(i / 2)] == null) {
                    data[Math.floor(i / 2)] = 0;
                }
                data[Math.floor(i / 2)] |= nibData.value << ((i % 2) * 4);
                ++nibCount;
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
