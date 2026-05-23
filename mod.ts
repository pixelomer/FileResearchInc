// Proxy support
const USE_PROXY = Deno.env.get("FILE_RESEARCH_USE_PROXY") === "1";
const PROXY_URL_SYMBOL = Symbol("PROXY_URL_SYMBOL");
const PROXY_IN_USE = Symbol("PROXY_IN_USE");
const SOCKS5_PROXY_LIST_URL = "https://raw.githubusercontent.com/Skillter/" +
    "ProxyGather/refs/heads/master/proxies/working-proxies-socks5.txt";

// Number of seconds for a nibble window.
const NIBBLE_WINDOW = 20;

// Maximum number of connections during upload. Higher number means
// more nibbles per second, but also higher risk of corruption and
// rate limit errors.
const UPLOAD_CONNECTION_COUNT = 8;

// Maximum number of connections during download.
const DOWNLOAD_CONNECTION_COUNT = 8;

// Number of seconds to sleep towards the end of each upload window.
const UPLOAD_WINDOW_GAP = 6;

// Configures the amount of time (in ms) to sleep before continuing after
// receiving an error response from the server. (Ignored when using proxies)
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

function rejectTimeout(ms: number) {
    return new Promise<void>((_, reject) => setTimeout(() => reject(), ms));
}

export function isSafeToWrite() {
    return getTime() % NIBBLE_WINDOW <= (NIBBLE_WINDOW - UPLOAD_WINDOW_GAP - 1);
}

export async function waitUntilSafeWrite() {
    if (isSafeToWrite()) {
        return false;
    }
    while (!isSafeToWrite()) {
        await sleep(100);
    }
    return true;
}

async function checkProxy(client: Deno.HttpClient): Promise<boolean> {
    const resPromise = fetch("https://numberresearch.xyz", { client });
    const fail = rejectTimeout(1000);
    try {
        await Promise.race([resPromise, fail]);
        return true;
    }
    catch {
        return false;
    }
}

function normalizedIP(url: string) {
    const match = url.match(/([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/)!;
    return match.toSpliced(0,1).map((a)=>a.padStart(3,"0")).join(".");
}

async function fetchLines(url: string) {
    const res = await fetch(url);
    const text = await res.text();
    return text.split("\n").map((a) => a.trim()).filter((a) => a);
}

async function fetchServerList() {
    return [...new Set([
        ...(await fetchLines(SOCKS5_PROXY_LIST_URL)).map((a) => "socks5://" + a)
    ])];
}

let _ensureProxyPromise: Promise<void> | null = null;
const _proxyClients: Deno.HttpClient[] = [];
let _queueFront = 0;
function prepareProxyList(): Promise<void> {
    if (_ensureProxyPromise != null) {
        return _ensureProxyPromise;
    }
    return _ensureProxyPromise = (async()=>{
        if (!USE_PROXY) {
            // no need to prepare anything
            return;
        }

        try {
            const savedProxies = await Deno.readTextFile("proxies.txt");
            const proxies = savedProxies.split("\n").filter((a) => a);
            for (const url of proxies) {
                if (url.includes("#")) continue;
                const client = Deno.createHttpClient({
                    proxy: {
                        url: url
                    }
                });
                (client as any)[PROXY_URL_SYMBOL] = normalizedIP(url);
                _proxyClients.push(client);
            }
        }
        catch (err) {
            console.error("Failed to load cached proxies, fetching proxies...")
            console.error(err);
            const serverList = await fetchServerList();

            const proxiesOut = await Deno.open("proxies.txt~", { create: true, append: true });
            for (const url of serverList) {
                const client = Deno.createHttpClient({
                    proxy: {
                        url: url
                    }
                });
                Deno.stderr.write(new TextEncoder().encode(`checking ${url} ... `));
                if (await checkProxy(client)) {
                    console.error("ok");
                    await proxiesOut.write(new TextEncoder().encode(url + "\n"));
                    (client as any)[PROXY_URL_SYMBOL] = normalizedIP(url);
                    _proxyClients.push(client);
                }
                else {
                    console.error("bad");
                }
            }
            proxiesOut.close();
        
            if (_proxyClients.length <= 0) {
                console.error("[ERROR] No SOCKS5 proxies available");
                Deno.exit(1);
            }
            await Deno.copyFile("proxies.txt~", "proxies.txt");
            await Deno.remove("proxies.txt~");
        }
    })();
}

export function tryCheckNumber(id: bigint, client?: Deno.HttpClient): Promise<Response> {
    const init: RequestInit & { client?: Deno.HttpClient } = {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ number: id.toString() }),
        client: client
    };
    return fetch("https://numberresearch.xyz/api/check", init);
}

let pickingProxy = false;
let _activePickerPromise: Promise<Deno.HttpClient> | null = null;
async function pickProxy(oldClient?: Deno.HttpClient) {
    if (!USE_PROXY) {
        return;
    }
    while (pickingProxy) {
        await _activePickerPromise;
    }
    returnProxy(oldClient);
    pickingProxy = true;
    _queueFront = (_queueFront + 1) % _proxyClients.length;
    _activePickerPromise = (async()=>{
        while ((_proxyClients[_queueFront] as any)[PROXY_IN_USE] ||
            !await checkProxy(_proxyClients[_queueFront]))
        {
            _queueFront = (_queueFront + 1) % _proxyClients.length;
        }
        pickingProxy = false;
        const client = _proxyClients[_queueFront];
        (client as any)[PROXY_IN_USE] = true;
        return client;
    })();
    return await _activePickerPromise;
}

function returnProxy(oldClient?: Deno.HttpClient) {
    if (oldClient != null) {
        (oldClient as any)[PROXY_IN_USE] = false;
    }
}

export async function tryFetchNibble(id: bigint, client?: Deno.HttpClient): Promise<NibbleData | null> {
    const data = {} as NibbleData;
    try {
        const res = await tryCheckNumber(id, client);
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
        if (!USE_PROXY) {
            console.error();
            console.error(err);
        }
    }
    if (data.value == null) {
        return null;
    }
    return data;
}

export async function fetchNibble(id: bigint): Promise<NibbleData> {
    let proxy = await pickProxy();
    let nibble: NibbleData | null;
    while ((nibble = await tryFetchNibble(id)) == null) {
        proxy = await pickProxy(proxy);
        if (!USE_PROXY) await sleep(RATE_LIMIT_DURATION);
    }
    returnProxy(proxy);
    return nibble;
}

export async function upload(key: bigint, path: string) {
    await prepareProxyList();
    const base = key << 32n;
    const file = await Deno.open(path, { read: true });
    const queued = [] as unknown as Record<Nibble, Set<number>>;
    const done = () => !(queued as unknown as Set<number>[]).some((s) => s.size > 0);
    let nextNibIdx = 0;
    let wrote = 0;
    let activeDownloads = 0;
    let errors = 0;
    const promises: (Promise<void> | null)[] = [];
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
    for (let i=0; i<UPLOAD_CONNECTION_COUNT; ++i) {
        let proxy = await pickProxy();
        const cb = async(): Promise<void> => {
            if (await waitUntilSafeWrite()) {
                proxy = await pickProxy(proxy);
            }
            const nib = currentNibble();
            const set = queued[nib];
            if (set.size > 0) {
                const nibIdx = set.values().next().value as number;
                set.delete(nibIdx);
                ++activeDownloads;
                const actualNibData = await tryFetchNibble(base + BigInt(nibIdx), proxy);
                if (actualNibData == null) {
                    set.add(nibIdx);
                    if (USE_PROXY) {
                        proxy = await pickProxy(proxy);
                    }
                    else {
                        await sleep(RATE_LIMIT_DURATION);
                    }
                    promises[i] = cb();
                    --activeDownloads;
                    return;
                }
                const actualNib = actualNibData.value;
                if (actualNib !== nib) {
                    console.error();
                    console.error(`ERROR: for nibble ${nibIdx}, tried to write ` +
                        `${nib.toString(16).toUpperCase()} but wrote ${actualNib.toString(16).toUpperCase()}`);
                    console.error(`       number: ${base + BigInt(nibIdx)}`);
                    if (USE_PROXY) {
                        console.error(`       proxy: ${(proxy as any)[PROXY_URL_SYMBOL]}`);
                    }
                    console.error(`       (make sure your system clock is correct)`);
                    ++errors;
                }
                ++wrote;
                --activeDownloads;
            }
            else {
                await sleep(1000);
            }
            if (!done()) {
                promises[i] = cb();
            }
            else {
                promises[i] = null;
                returnProxy(proxy);
            }
        };
        promises.push(cb());
    }
    while (promises.some((a) => a != null)) {
        await Promise.all([...promises]);
    }
    clearInterval(interval);
    await intervalCb();
    console.error();
    
    // upload completion timestamp
    await fetchNibble(base-1n);
}

export async function download(key: bigint, writable: WritableStream) {
    await prepareProxyList();
    const base = key << 32n;
    const promises: (Promise<void> | null)[] = [];
    const writer = writable.getWriter();
    let nibCount = 0;
    let lastIndex = Number.MAX_SAFE_INTEGER;
    const intervalCb = async() => {
        const text = `\rread ${nibCount} nibs (= ${(nibCount/2).toFixed(1)} bytes)`;
        await Deno.stderr.write(new TextEncoder().encode(text));
    };
    const interval = setInterval(intervalCb, 250);
    const completionTimestamp = (await fetchNibble(base-1n)).date;
    const data: number[] = [];
    let next = 0;
    const backlog: number[] = [];
    for (let worker = 0; worker < DOWNLOAD_CONNECTION_COUNT; ++worker) {
        let proxy = await pickProxy();
        const cb = async(): Promise<void> => {
            await 0; // defer execution until the promises array is ready
            let i: number;
            if (backlog.length > 0) {
                i = backlog.pop()!;
            }
            else {
                i = next++;
            }
            if (i >= lastIndex) {
                promises[worker] = null;
                returnProxy(proxy);
                return;
            }
            const nibData = await tryFetchNibble(base + BigInt(i), proxy);
            if (nibData == null) {
                backlog.push(i);
                proxy = await pickProxy(proxy);
                promises[worker] = cb();
                return;
            }
            if (nibData.date.valueOf() > completionTimestamp.valueOf() || nibData.isNew) {
                lastIndex = Math.min(lastIndex, i);
                promises[worker] = cb();
            }
            else {
                if (data[Math.floor(i / 2)] == null) {
                    data[Math.floor(i / 2)] = 0;
                }
                data[Math.floor(i / 2)] |= nibData.value << ((i % 2) * 4);
                ++nibCount;
                promises[worker] = cb();
            }
        };
        const promise = cb();
        promises.push(promise);
    }
    while (promises.some((a) => a != null)) {
        await Promise.all([...promises]);
    }
    await writer.write(new Uint8Array(data));
    writer.close();
    clearInterval(interval);
    await intervalCb();
    console.error();
}
