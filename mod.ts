// Proxy support
const USE_PROXY = Deno.env.get("FILE_RESEARCH_USE_PROXY") === "1";
const kProxyURL = Symbol("kProxyURL");
const kInUse = Symbol("kInUse");
const proxyListURLs = [
    {
        url: "https://api.proxyscrape.com/v4/free-proxy-list/get" +
            "?request=display_proxies&proxy_format=protocolipport&format=text&protocol=socks5",
        prepend: ""
    },
    {
        url: "https://raw.githubusercontent.com/Skillter/" +
            "ProxyGather/refs/heads/master/proxies/working-proxies-socks5.txt",
        prepend: "socks5://"
    },
    {
        url: "https://raw.githubusercontent.com/roosterkid/" +
            "openproxylist/refs/heads/main/SOCKS5_RAW.txt",
        prepend: "socks5://"
    },
    {
        url: "https://raw.githubusercontent.com/roosterkid/" +
            "openproxylist/refs/heads/main/HTTPS_RAW.txt",
        prepend: "https://"
    },
];

// Maximum number of connections during upload.
const UPLOAD_CONNECTION_COUNT = 10;

// Maximum number of connections during download.
const DOWNLOAD_CONNECTION_COUNT = 10;

// Configures the amount of time (in ms) to sleep before continuing after
// receiving an error response from the server. (Ignored when using proxies)
const RATE_LIMIT_DURATION = 15000;

export type Nibble = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;
export type ProxyClient = Deno.HttpClient & { [kProxyURL]: string, [kInUse]: boolean };

export interface NumberData {
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

function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
}

function rejectTimeout(ms: number) {
    return new Promise<void>((_, reject) => setTimeout(() => reject(), ms));
}

let elapsedTimerStart = Date.now();
function resetElapsed() {
    elapsedTimerStart = Date.now();
}

function elapsed() {
    const diff = (Date.now() - elapsedTimerStart) / 1000;
    return `${Math.floor(diff / 3600).toString().padStart(2, "0")}:` +
        `${Math.floor((diff / 60) % 60).toString().padStart(2, "0")}:` +
        `${Math.floor(diff % 60).toString().padStart(2, "0")}`;
}

async function checkProxy(client: Deno.HttpClient): Promise<boolean> {
    const abort = new AbortController();
    const resPromise = fetch("https://numberresearch.xyz", { client, signal: abort.signal });
    const fail = rejectTimeout(1000);
    try {
        await Promise.race([resPromise, fail]);
        await Promise.race([(await resPromise).text(), fail]);
        return true;
    }
    catch {
        return false;
    }
    finally {
        abort.abort();
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
    const set = new Set<string>();
    for (const entry of proxyListURLs) {
        const list = await fetchLines(entry.url);
        for (const url of list) {
            set.add(entry.prepend + url);
        }
    }
    return [...set];
}

let _ensureProxyPromise: Promise<void> | null = null;
const _proxyClients: ProxyClient[] = [];
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
                }) as ProxyClient;
                client[kProxyURL] = normalizedIP(url);
                client[kInUse] = false;
                _proxyClients.push(client);
            }
        }
        catch (err) {
            console.error("Failed to load cached proxies, fetching proxies...")
            console.error(err);
            const serverList = await fetchServerList();

            (await Deno.open("proxies.txt~", { create: true, write: true, truncate: true })).close();
            const proxiesOut = await Deno.open("proxies.txt~", { create: true, append: true });
            const connectionCount = Math.min(DOWNLOAD_CONNECTION_COUNT, UPLOAD_CONNECTION_COUNT);
            for (let i=0; i<serverList.length; i+=connectionCount) {
                const testList = serverList.slice(i, i+connectionCount);
                const clients = testList.map((a) => Deno.createHttpClient({
                    proxy: { url: a }
                })) as ProxyClient[];
                const results = await Promise.all(clients.map((a) => checkProxy(a)));
                for (let i=0; i<results.length; ++i) {
                    const url = testList[i];
                    const client = clients[i];
                    if (results[i]) {
                        console.error(`[found] ${url}`);
                        await proxiesOut.write(new TextEncoder().encode(url + "\n"));
                        client[kProxyURL] = normalizedIP(url);
                        client[kInUse] = false;
                        _proxyClients.push(client);
                    }
                    else {
                        //console.error("bad");
                    }
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

async function pickProxy(oldClient?: ProxyClient): Promise<ProxyClient> {
    if (!USE_PROXY) {
        return undefined as unknown as ProxyClient;
    }
    returnProxy(oldClient);
    let viable: boolean;
    let chosen: number;
    do {
        do {
            _queueFront = (_queueFront + 1) % _proxyClients.length;
        } while (_proxyClients[_queueFront][kInUse]);
        chosen = _queueFront;
        _proxyClients[chosen][kInUse] = true;
        viable = await checkProxy(_proxyClients[chosen]);
        if (!viable) {
            _proxyClients[chosen][kInUse] = false;
        }
    } while (!viable);
    const client = _proxyClients[chosen];
    client[kInUse] = true;
    return client;
}

function returnProxy(oldClient?: ProxyClient) {
    if (oldClient != null) {
        oldClient[kInUse] = false;
    }
}

export async function tryFetchNumber(id: bigint, client?: ProxyClient): Promise<NumberData | null> {
    const data = {} as NumberData;
    const abort = new AbortController();
    try {
        const init: RequestInit & { client?: Deno.HttpClient } = {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ number: id.toString() }),
            signal: abort.signal,
            client: client
        };
        const resPromise = fetch("https://numberresearch.xyz/api/check", init);
        const fail = rejectTimeout(2000);
        const res = (await Promise.race([resPromise, fail])) as Response;
        const json = (await Promise.race([res.json(), fail]));
        if (!res.ok) {
            if (res.status !== 429) {
                console.error("\nHTTP", res.status);
                console.error(json);
            }
        }
        else {
            data.date = new Date(json.discovered_at);
            data.isNew = json.is_new;
        }
    }
    catch (err) {
        if (!USE_PROXY) {
            console.error();
            console.error(err);
        }
    }
    finally {
        abort.abort();
    }
    if (data.date == null) {
        return null;
    }
    return data;
}

export async function fetchNumbers(ids: bigint[]): Promise<NumberData[]> {
    let proxy = await pickProxy();
    const numberData: NumberData[] = [];
    for (let i=0; i<ids.length; ++i) {
        while ((numberData[i] = (await tryFetchNumber(ids[i]))!) == null) {
            proxy = await pickProxy(proxy);
            if (!USE_PROXY) await sleep(RATE_LIMIT_DURATION);
        }
    }
    returnProxy(proxy);
    return numberData;
}

export async function fetchNumber(id: bigint): Promise<NumberData> {
    return (await fetchNumbers([id]))[0];
}

export async function upload(key: bigint, path: string) {
    await prepareProxyList();
    resetElapsed();
    const base = key << 32n;
    const file = await Deno.open(path, { read: true });
    const queued = [] as unknown as Record<Nibble, Set<number>>;
    let nextNibIdx = 0;
    let wrote = 0;
    let activeConnections = 0;
    const promises: (Promise<void> | null)[] = [];
    const intervalCb = async() => {
        const text = `\rwrote ${wrote} nibs (= ${(wrote/2).toFixed(1)} bytes, ` +
            `${activeConnections} conns, nib ${currentNibble.toString(16).toUpperCase()}, ${elapsed()})`
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
    let currentNibble: number;
    for (currentNibble = 0; currentNibble < 16; ++currentNibble) {
        await fetchNumber(base + 1n + BigInt(currentNibble));
        for (let i=0; i<UPLOAD_CONNECTION_COUNT; ++i) {
            let proxy = await pickProxy();
            const cb = async(): Promise<void> => {
                await 0;
                const set = queued[currentNibble as Nibble];
                if (set.size > 0) {
                    const nibIdx = set.values().next().value as number;
                    set.delete(nibIdx);
                    ++activeConnections;
                    const actualNibData = await tryFetchNumber(base + 17n + BigInt(nibIdx), proxy);
                    if (actualNibData == null) {
                        set.add(nibIdx);
                        if (USE_PROXY) {
                            proxy = await pickProxy(proxy);
                        }
                        else {
                            await sleep(RATE_LIMIT_DURATION);
                        }
                    }
                    else {
                        ++wrote;
                    }
                    --activeConnections;
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
        promises.splice(0);
    }
    clearInterval(interval);
    await intervalCb();
    console.error();
    
    // upload completion timestamp
    await fetchNumber(base);
}

export async function download(key: bigint, writable: WritableStream) {
    await prepareProxyList();
    resetElapsed();
    const base = key << 32n;
    const promises: (Promise<void> | null)[] = [];
    const writer = writable.getWriter();
    let nibCount = 0;
    let lastIndex = Number.MAX_SAFE_INTEGER;
    const intervalCb = async() => {
        const text = `\rread ${nibCount} nibs (= ${(nibCount/2).toFixed(1)} bytes, ${elapsed()})`;
        await Deno.stderr.write(new TextEncoder().encode(text));
    };
    const interval = setInterval(intervalCb, 250);
    const header =
        (await fetchNumbers(new Array(17).fill(0).map((_,i) => base + BigInt(i))))
        .map((data) => data.date);
    const completionTimestamp = header[0];
    const nibbleTimestamps = header.slice(1, 17);
    const nibbleForDate = (storedDate: Date) => {
        const nibble = nibbleTimestamps.findLastIndex((nibbleStart) => storedDate > nibbleStart);
        return nibble;
    }
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
            const numberData = await tryFetchNumber(base + 17n + BigInt(i), proxy);
            if (numberData == null) {
                backlog.push(i);
                proxy = await pickProxy(proxy);
                promises[worker] = cb();
                return;
            }
            if (numberData.date.valueOf() > completionTimestamp.valueOf() || numberData.isNew) {
                lastIndex = Math.min(lastIndex, i);
                promises[worker] = cb();
            }
            else {
                if (data[Math.floor(i / 2)] == null) {
                    data[Math.floor(i / 2)] = 0;
                }
                data[Math.floor(i / 2)] |= nibbleForDate(numberData.date) << ((i % 2) * 4);
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
