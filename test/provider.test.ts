import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { AnkrProvider } from "../src/provider";
import {
    startStub,
    REFUSED_URL,
    NO_REPLY_STATUS,
    Stub,
} from "./helpers/stubServer";

/**
 * The contract of AnkrProvider's HTTP layer.
 *
 * WHY THIS SUITE EXISTS. The SDK has exactly one axios call site, and the axios
 * 0.x -> 1.x upgrade is a breaking major for the caller: serialisation, error
 * classes, decompression and status handling all live on axios's side of that
 * line. A silent change there does not crash — it surfaces downstream as a
 * consumer reading the wrong field, so it has to be pinned by assertion rather
 * than by reading the diff.
 *
 * Every scenario below is written against a REAL loopback HTTP server, never a
 * mocked axios, because a mocked axios would assert nothing about an axios
 * upgrade.
 *
 * NOTE ON THE GATE: `yarn typecheck` covers `src` only, so this directory is NOT
 * typechecked. That is not an oversight to fix here — typescript 4.6.2 cannot
 * parse any current @types/node (1362-1423 parse errors on majors 16 through
 * 22), so there is no @types/node in devDependencies and `tsx` runs these files
 * by stripping types rather than checking them. Bumping typescript is the fix,
 * and it does not belong in a dependency-security change.
 */

const NUM_PUBLIC_METHODS = 18;

/** method on AnkrProvider -> JSON-RPC method it must send. */
const METHOD_MAP: ReadonlyArray<[string, string]> = [
    ["getLogs", "ankr_getLogs"],
    ["getBlocks", "ankr_getBlocks"],
    ["getTransactionsByHash", "ankr_getTransactionsByHash"],
    ["getTransactionsByAddress", "ankr_getTransactionsByAddress"],
    ["getTokenTransfers", "ankr_getTokenTransfers"],
    ["getNftTransfers", "ankr_getNftTransfers"],
    ["getAccountBalance", "ankr_getAccountBalance"],
    ["getNFTsByOwner", "ankr_getNFTsByOwner"],
    ["getNFTMetadata", "ankr_getNFTMetadata"],
    ["getNFTHolders", "ankr_getNFTHolders"],
    ["getTokenHolders", "ankr_getTokenHolders"],
    ["getTokenHoldersCount", "ankr_getTokenHoldersCount"],
    ["getTokenPrice", "ankr_getTokenPrice"],
    ["getCurrencies", "ankr_getCurrencies"],
    ["getTokenPriceHistory", "ankr_getTokenPriceHistory"],
    ["explainTokenPrice", "ankr_explainTokenPrice"],
    ["getBlockchainStats", "ankr_getBlockchainStats"],
    ["getInteractions", "ankr_getInteractions"],
];

type AnyProvider = Record<string, (p: unknown) => Promise<unknown>>;

const ok = (result: unknown, id = 1) => ({
    body: { jsonrpc: "2.0", id, result },
});

describe("AnkrProvider HTTP contract", () => {
    let stub: Stub;

    before(async () => {
        stub = await startStub();
    });
    after(async () => {
        await stub.close();
    });

    test("the public method surface is exactly the documented set", () => {
        const p = new AnkrProvider(stub.url);
        const names = Object.getOwnPropertyNames(
            Object.getPrototypeOf(p)
        ).filter((n) => n !== "constructor");

        for (const [name] of METHOD_MAP) {
            assert.ok(
                names.includes(name),
                `${name} is missing from the prototype`
            );
        }
        // `send` is `private` in TypeScript, which is erased at compile time, so it
        // is reachable at runtime and shows up here. Asserted rather than filtered
        // away: if a future refactor adds another reachable member, this fails and
        // someone decides deliberately whether it is API.
        //
        // Nothing is filtered by name. An earlier revision also dropped anything
        // starting with "_", which would have hidden a future `_send` or `_retry`
        // and broken the promise this test exists to make. The instance fields
        // (`url`, `requestConfig`, `_nextId`) are own properties, not prototype
        // members, so they never appear here anyway.
        const extra = names.filter(
            (n) => !METHOD_MAP.some(([m]) => m === n)
        );
        assert.deepEqual(
            extra,
            ["send"],
            `unexpected runtime-reachable members: ${extra.join(", ")}`
        );
        assert.equal(names.length, NUM_PUBLIC_METHODS + 1);
    });

    describe("given a public method, when called, then it sends the right JSON-RPC request", () => {
        for (const [fn, rpcMethod] of METHOD_MAP) {
            test(`${fn} -> ${rpcMethod}`, async () => {
                const provider = new AnkrProvider(stub.url) as unknown as AnyProvider;
                const params = { blockchain: "eth", probe: fn };
                stub.reply(ok({ marker: fn }));
                const before = stub.requests.length;

                const result = await provider[fn](params);

                assert.equal(stub.requests.length, before + 1);
                const req = stub.requests[stub.requests.length - 1];

                assert.equal(req.method, "POST", "must be a POST");
                assert.equal(req.url, "/multichain/test-key", "path must be preserved verbatim");

                // The body is a pre-serialised JSON string, and its exact text is
                // part of the contract: key order included, because a JSON-RPC
                // endpoint is entitled to nothing more than valid JSON but our
                // fixtures and any request-signing consumer see the literal bytes.
                assert.equal(
                    req.rawBody,
                    JSON.stringify({
                        method: rpcMethod,
                        params,
                        id: 1,
                        jsonrpc: "2.0",
                    }),
                    "serialised request body changed"
                );

                assert.equal(
                    req.headers["content-type"],
                    "application/json",
                    "Content-Type must survive as set in requestConfig"
                );
                assert.equal(
                    req.headers["accept-encoding"],
                    "gzip",
                    "Accept-Encoding must survive as set in requestConfig"
                );

                assert.deepEqual(result, { marker: fn }, "result must be returned verbatim");
            });
        }
    });

    test("given repeated calls on one provider, when sent, then id increments from 1", async () => {
        const provider = new AnkrProvider(stub.url);
        const seen: number[] = [];
        for (let i = 0; i < 3; i++) {
            stub.reply(ok(i));
            const before = stub.requests.length;
            await provider.getTokenPrice({ blockchain: "eth" } as never);
            const body = JSON.parse(stub.requests[before].rawBody) as { id: number };
            seen.push(body.id);
        }
        assert.deepEqual(seen, [1, 2, 3]);
    });

    test("given two providers, when each sends, then ids are per-instance", async () => {
        const a = new AnkrProvider(stub.url);
        const b = new AnkrProvider(stub.url);
        stub.reply(ok(null));
        let n = stub.requests.length;
        await a.getCurrencies({ blockchain: "eth" } as never);
        const idA = (JSON.parse(stub.requests[n].rawBody) as { id: number }).id;
        stub.reply(ok(null));
        n = stub.requests.length;
        await b.getCurrencies({ blockchain: "eth" } as never);
        const idB = (JSON.parse(stub.requests[n].rawBody) as { id: number }).id;
        assert.equal(idA, 1);
        assert.equal(idB, 1);
    });

    describe("given a falsy JSON-RPC result, when returned, then it is not swallowed", () => {
        for (const value of [0, false, "", null] as const) {
            test(`result = ${JSON.stringify(value)}`, async () => {
                const provider = new AnkrProvider(stub.url);
                stub.reply(ok(value));
                const out = await provider.getTokenPrice({ blockchain: "eth" } as never);
                assert.equal(out as unknown, value);
            });
        }
    });

    test("given a gzipped response, when received, then it is transparently decompressed", async () => {
        const provider = new AnkrProvider(stub.url);
        stub.reply({ body: { jsonrpc: "2.0", id: 1, result: { zipped: true } }, gzip: true });
        const out = await provider.getBlockchainStats({ blockchain: "eth" } as never);
        assert.deepEqual(out as unknown, { zipped: true });
    });

    test("given a large response, when received, then it is not truncated", async () => {
        const provider = new AnkrProvider(stub.url);
        // ~4 MB. axios has changed its maxContentLength / streaming defaults across
        // majors, and the AAPI returns responses of this order on getLogs.
        //
        // Shaped as a real GetLogsReply ({ logs, nextPageToken }) rather than a bare
        // array. An earlier revision returned an array and cast the result to
        // `unknown[]`, which both hid a genuine type error and asserted against a
        // payload the API never sends.
        const logs = Array.from({ length: 40000 }, (_, i) => ({
            blockchain: "eth",
            address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            blockNumber: `0x${i.toString(16)}`,
            data: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        }));
        stub.reply(ok({ logs, nextPageToken: "next" }));
        const out = await provider.getLogs({ blockchain: "eth" } as never);
        assert.equal(out.logs.length, logs.length, "log count changed: response was truncated");
        assert.deepEqual(out.logs[logs.length - 1], logs[logs.length - 1]);
        assert.equal(out.nextPageToken, "next");
    });

    describe("given a body that is not a JSON-RPC envelope, then the current behaviour is pinned", () => {
        // NOT an endorsement. getResult sees neither `error` nor `result` on a
        // non-envelope payload and returns `payload.result`, i.e. undefined, so a
        // 200 carrying a gateway HTML page RESOLVES with undefined instead of
        // throwing. That is a real pre-existing wart and it belongs to the SDK, not
        // to axios: it is byte-identical on 0.30.3 and on 1.19.0, which is exactly
        // why it is pinned here. If it is ever fixed, this test is the one that
        // should fail and be rewritten deliberately.
        const cases: ReadonlyArray<[string, string, string]> = [
            ["an HTML error page", "text/html", "<html>502 Bad Gateway</html>"],
            ["an empty body", "application/json", ""],
        ];
        for (const [name, contentType, raw] of cases) {
            test(`${name} resolves undefined rather than throwing`, async () => {
                const provider = new AnkrProvider(stub.url);
                stub.reply({ status: 200, contentType, raw });
                const out = await provider.getLogs({ blockchain: "eth" } as never);
                assert.equal(out as unknown, undefined);
            });
        }

        test("JSON under a text/plain content type is still parsed", async () => {
            const provider = new AnkrProvider(stub.url);
            stub.reply({
                status: 200,
                contentType: "text/plain",
                raw: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { logs: [] } }),
            });
            const out = await provider.getLogs({ blockchain: "eth" } as never);
            assert.deepEqual(out as unknown, { logs: [] });
        });
    });

    test("given no reply queued, when a request arrives, then the stub fails loudly", async () => {
        // Guards the guard: proves a forgotten reply() cannot pass silently.
        const provider = new AnkrProvider(stub.url);
        const e = await provider
            .getLogs({ blockchain: "eth" } as never)
            .then(() => undefined)
            .catch((err: unknown) => err);
        assert.ok(e instanceof Error, "an unqueued request must not resolve");
        assert.equal(
            (e as { response?: { status?: unknown } }).response?.status,
            NO_REPLY_STATUS
        );
    });

    describe("error propagation", () => {
        test("given a JSON-RPC error body, when received, then it throws with numeric code and data", async () => {
            const provider = new AnkrProvider(stub.url);
            stub.reply({
                body: {
                    jsonrpc: "2.0",
                    id: 1,
                    error: { code: -32602, message: "invalid params", data: { hint: "blockchain" } },
                },
            });
            const e = await provider
                .getTokenPrice({ blockchain: "eth" } as never)
                .then(() => undefined)
                .catch((err: unknown) => err);

            assert.ok(e instanceof Error, "must be an Error");
            assert.equal(e.message, "invalid params");
            // The consuming boundary (agent-rpc-mcp aapi/errors.ts) tells a JSON-RPC
            // failure from a transport failure by `typeof code`. A number here and a
            // string there is the whole discriminator, so both are asserted.
            assert.equal(typeof (e as { code?: unknown }).code, "number");
            assert.equal((e as { code?: unknown }).code, -32602);
            assert.deepEqual((e as { data?: unknown }).data, { hint: "blockchain" });
            assert.equal(
                (e as { response?: unknown }).response,
                undefined,
                "a JSON-RPC error must not carry an HTTP response"
            );
        });

        test("given an error body with a 200 status, when received, then the error still wins", async () => {
            const provider = new AnkrProvider(stub.url);
            stub.reply({
                status: 200,
                body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nope" }, result: "ignored" },
            });
            const e = await provider
                .getLogs({ blockchain: "eth" } as never)
                .then(() => undefined)
                .catch((err: unknown) => err);
            assert.ok(e instanceof Error);
            assert.equal(e.message, "nope");
        });

        for (const status of [400, 401, 403, 429, 500, 503] as const) {
            test(`given HTTP ${status}, when received, then it throws carrying response.status = ${status}`, async () => {
                const provider = new AnkrProvider(stub.url);
                stub.reply({ status, body: { error: { code: -32001, message: "upstream prose" } } });
                const e = await provider
                    .getAccountBalance({ blockchain: "eth" } as never)
                    .then(() => undefined)
                    .catch((err: unknown) => err);

                assert.ok(e instanceof Error, "must be an Error");
                // THE load-bearing assertion for the MCP consumer: it classifies on
                // e.response.status before anything else.
                const response = (e as { response?: { status?: unknown } }).response;
                assert.ok(response, "must carry a response");
                assert.equal(response.status, status);
                assert.equal(
                    typeof (e as { code?: unknown }).code,
                    "string",
                    "axios reports a transport/HTTP failure with a STRING code"
                );
            });
        }

        test("given a refused connection, when sent, then it throws with a string transport code", async () => {
            const provider = new AnkrProvider(REFUSED_URL);
            const e = await provider
                .getInteractions({ blockchain: "eth" } as never)
                .then(() => undefined)
                .catch((err: unknown) => err);

            assert.ok(e instanceof Error);
            const code = (e as { code?: unknown }).code;
            assert.equal(typeof code, "string");
            // Must stay inside the set the MCP boundary treats as transient.
            const transient = new Set([
                "ECONNABORTED",
                "ECONNREFUSED",
                "ECONNRESET",
                "EAI_AGAIN",
                "ENOTFOUND",
                "EPIPE",
                "ETIMEDOUT",
                "ERR_NETWORK",
            ]);
            assert.ok(
                transient.has(code as string),
                `transport code ${String(code)} is outside the retryable set the consumer knows`
            );
            assert.equal(
                (e as { response?: unknown }).response,
                undefined,
                "a transport failure has no response"
            );
        });
    });
});
