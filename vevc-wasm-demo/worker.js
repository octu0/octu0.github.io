// Suppress non-fatal ReferenceErrors from JavaScriptKit's JSObjectSpace reference lifecycle.
// These occur when Swift-side JSPromise resolvers interact with already-released JS object refs,
// but do not affect actual encode/decode functionality.
self.addEventListener('unhandledrejection', (event) => {
    if (event.reason && event.reason.message && event.reason.message.includes('invalid reference')) {
        event.preventDefault();
        return;
    }
    console.error('[Worker] Unhandled rejection:', event.reason);
});

import { init } from './index.js';

let encoderId = null;
let decoderId = null;
let wasmExports = null;

// Track in-flight frames: incremented when encodeFrame is called,
// decremented when a decoded frame is produced.
// This provides end-to-end backpressure from extraction through encode+decode.
let inflight = 0;

async function startWasm() {
    try {
        const res = await init();
        wasmExports = res.exports;
        postMessage({ type: 'vevc-ready' });
    } catch (err) {
        postMessage({ type: 'vevc-error', payload: "WASM Load Error: " + err.toString() });
    }
}

onmessage = (e) => {
    const { type, payload } = e.data;
    if (type === 'init-vevc') {
        const { width, height, bitrate, framerate } = payload;
        
        if (encoderId !== null && wasmExports.closeEncoder) {
            wasmExports.closeEncoder(encoderId);
            encoderId = null;
        }
        if (decoderId !== null && wasmExports.closeDecoder) {
            wasmExports.closeDecoder(decoderId);
            decoderId = null;
        }

        inflight = 0;

        try {
            encoderId = wasmExports.createEncoder(width, height, bitrate, framerate, (chunkRaw) => {
                const chunk = new Uint8Array(chunkRaw);
                postMessage({ type: 'vevc-chunk', payload: chunk });
                
                // Feed encoded chunk to the decoder pipeline.
                // Must defer via queueMicrotask to escape the synchronous Swift callback context;
                // calling another WASM export (decodeChunk) inside a Swift callback causes
                // reference lifecycle conflicts (retain/release timing mismatch).
                if (decoderId !== null) {
                    const localDecoderId = decoderId;
                    const chunkCopy = chunk.slice();
                    queueMicrotask(() => {
                        try {
                            wasmExports.decodeChunk(localDecoderId, chunkCopy);
                        } catch (e) {
                            // Non-fatal: reference errors from JavaScriptKit
                        }
                    });
                }
            });
            
            decoderId = wasmExports.createDecoder((frameObject) => {
                const arr = new Uint8Array(frameObject.data);
                const copyBuf = arr.slice().buffer;
                inflight--;
                postMessage({
                    type: 'vevc-frame',
                    payload: {
                        width: Number(frameObject.width),
                        height: Number(frameObject.height),
                        data: copyBuf
                    }
                }, [copyBuf]);
                // Report inflight count for backpressure
                postMessage({ type: 'vevc-inflight', payload: inflight });
            });

        } catch (err) {
            postMessage({ type: 'vevc-error', payload: "Failed to create encoder/decoder: " + err });
        }
    } else if (type === 'encode-frame') {
        const { data } = payload;
        if (encoderId !== null && wasmExports && wasmExports.encodeFrame) {
            inflight++;
            try {
                // encodeFrame synchronously yields to the AsyncStream;
                // actual encoding happens asynchronously in a Swift Task.
                // The returned Promise resolves immediately and is not awaited.
                wasmExports.encodeFrame(encoderId, new Uint8Array(data));
            } catch (err) {
                inflight--;
                // Non-fatal: reference errors from JavaScriptKit
            }
            // Report inflight count for backpressure
            postMessage({ type: 'vevc-inflight', payload: inflight });
        }
    } else if (type === 'flush-vevc') {
        // Close the encoder to signal end-of-stream to the Swift AsyncStream.
        // This causes continuation.finish() to be called, flushing any buffered frames
        // through the encode → decode pipeline.
        if (encoderId !== null && wasmExports && wasmExports.closeEncoder) {
            try {
                wasmExports.closeEncoder(encoderId);
            } catch (e) {
                // Non-fatal
            }
            encoderId = null;
        }
    }
};

startWasm().catch(err => postMessage({ type: 'vevc-error', payload: "WASM Load Error: " + err.toString() }));
