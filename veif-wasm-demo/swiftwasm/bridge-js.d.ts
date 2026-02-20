// NOTICE: This is auto-generated code by BridgeJS from JavaScriptKit,
// DO NOT EDIT.
//
// To update this file, just rebuild your project or run
// `swift package bridge-js`.

export type Exports = {
    encodeOne(data: any, width: number, height: number, bitrate: number, onSuccess: any, onError: any): void;
    decodeOne(data: any, onSuccess: any, onError: any): void;
    encode(data: any, width: number, height: number, bitrate: number, onSuccess: any, onError: any): void;
    decode(data: any, onSuccess: any, onError: any): void;
    decodeUpTo(data: any, maxLayer: number, onSuccess: any, onError: any): void;
}
export type Imports = {
}
export function createInstantiator(options: {
    imports: Imports;
}, swift: any): Promise<{
    addImports: (importObject: WebAssembly.Imports) => void;
    setInstance: (instance: WebAssembly.Instance) => void;
    createExports: (instance: WebAssembly.Instance) => Exports;
}>;