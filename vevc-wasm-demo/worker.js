import { init } from './index.js';

let encoderId = null;
let decoderId = null;
let wasmExports = null;

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

        // wasmExports.createEncoder / wasmExports.createDecoder are exposed by @JS in Swift
        try {
            encoderId = wasmExports.createEncoder(width, height, bitrate, framerate, (chunkRaw) => {
                const chunk = new Uint8Array(chunkRaw);
                postMessage({ type: 'vevc-chunk', payload: chunk });
                
                // Immediately feed back to the decoder pipeline
                if (decoderId !== null) {
                    console.log(`[Worker] Passing chunk to decoder. Length: ${chunk.byteLength}. Total chunks so far: ${stateChunkCount++}`);
                    try {
                        const t0 = performance.now();
                        wasmExports.decodeChunk(decoderId, chunk);
                        console.log(`[Worker] Decode finished in ${performance.now() - t0}ms`);
                    } catch (e) {
                        console.error("[Worker] Error inside decodeChunk:", e);
                    }
                }
            });
            
            let stateChunkCount = 0;
            let stateFrameCount = 0;
            decoderId = wasmExports.createDecoder((frameObject) => {
                const arr = new Uint8Array(frameObject.data);
                const copyBuf = arr.slice().buffer;
                console.log(`[Worker] Emitting frame from decoder. Total frames emitted so far: ${stateFrameCount++}`);
                postMessage({
                    type: 'vevc-frame',
                    payload: {
                        width: Number(frameObject.width),
                        height: Number(frameObject.height),
                        data: copyBuf
                    }
                }, [copyBuf]);
            });
        } catch (err) {
            postMessage({ type: 'vevc-error', payload: "Failed to create encoder/decoder: " + err });
        }
    } else if (type === 'encode-frame') {
        const { data } = payload;
        if (encoderId !== null && wasmExports && wasmExports.encodeFrame) {
            wasmExports.encodeFrame(encoderId, new Uint8Array(data));
        }
    }
};

startWasm().catch(err => postMessage({ type: 'vevc-error', payload: "WASM Load Error: " + err.toString() }));
