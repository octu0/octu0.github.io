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
                    wasmExports.decodeChunk(decoderId, chunk);
                }
            });
            
            decoderId = wasmExports.createDecoder((frameObject) => {
                postMessage({
                    type: 'vevc-frame',
                    payload: {
                        width: Number(frameObject.width),
                        height: Number(frameObject.height),
                        data: new Uint8Array(frameObject.data) // Extract from JSValue
                    }
                });
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
