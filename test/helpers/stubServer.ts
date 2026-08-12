import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { gzipSync } from "node:zlib";
import { AddressInfo } from "node:net";

export type Recorded = {
    method: string | undefined;
    url: string | undefined;
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
};

export type Reply = {
    status?: number;
    contentType?: string;
    body?: unknown;
    /** Send the body gzipped, with Content-Encoding: gzip. */
    gzip?: boolean;
    /** Send this exact string instead of JSON.stringify(body). */
    raw?: string;
};

export type Stub = {
    url: string;
    requests: Recorded[];
    /** Queue a reply. Exactly one is consumed per request. */
    reply: (r: Reply) => void;
    close: () => Promise<void>;
};

/** Status returned when a test drove a request without queueing a reply. */
export const NO_REPLY_STATUS = 599;

/**
 * A real HTTP server on loopback. Tests point AnkrProvider at it so the whole
 * axios request path runs for real: no axios mock, no interceptor stub. That is
 * deliberate — the behaviour this suite pins is precisely the part axios owns
 * (serialisation, headers, decompression, status handling), and a mocked axios
 * would assert nothing about an axios upgrade.
 *
 * A queued reply is consumed exactly once and there is NO fallback. An earlier
 * revision reused the previous reply when the queue ran dry, which quietly made
 * assertions vacuous: the `result === null` case passed whether or not its own
 * reply had taken effect, because the idle default happened to be `result: null`.
 * Now a missing reply answers NO_REPLY_STATUS, so the test that forgot fails
 * instead of passing for the wrong reason.
 */
export const startStub = async (): Promise<Stub> => {
    const requests: Recorded[] = [];
    const queue: Reply[] = [];

    const server: Server = createServer(
        (req: IncomingMessage, res: ServerResponse) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                requests.push({
                    method: req.method,
                    url: req.url,
                    headers: req.headers,
                    rawBody: Buffer.concat(chunks).toString("utf8"),
                });
                const r = queue.shift();
                if (r === undefined) {
                    const msg = Buffer.from(
                        JSON.stringify({ stubError: "no reply queued for this request" }),
                        "utf8"
                    );
                    res.writeHead(NO_REPLY_STATUS, {
                        "Content-Type": "application/json",
                        "Content-Length": String(msg.length),
                    });
                    res.end(msg);
                    return;
                }
                const payload =
                    r.raw !== undefined ? r.raw : JSON.stringify(r.body ?? null);
                const buf = r.gzip
                    ? gzipSync(Buffer.from(payload, "utf8"))
                    : Buffer.from(payload, "utf8");
                const headers: Record<string, string> = {
                    "Content-Type": r.contentType ?? "application/json",
                    "Content-Length": String(buf.length),
                };
                if (r.gzip) headers["Content-Encoding"] = "gzip";
                res.writeHead(r.status ?? 200, headers);
                res.end(buf);
            });
        }
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    return {
        url: `http://127.0.0.1:${port}/multichain/test-key`,
        requests,
        reply: (r: Reply) => queue.push(r),
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((e) => (e ? reject(e) : resolve()))
            ),
    };
};

/**
 * An address that refuses deterministically. Port 1 is privileged, so no test
 * process can be listening there, and a loopback connection to a closed port is
 * refused immediately rather than timing out.
 *
 * Not an ephemeral port that was bound and released: that port goes back to the
 * OS, so a concurrently starting stub can claim it between the release and the
 * request. The connection would then succeed, the call would resolve, and the
 * transport-failure test would fail intermittently for no real reason.
 */
export const REFUSED_URL = "http://127.0.0.1:1/multichain/test-key";
