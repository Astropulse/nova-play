// Minimal GIF frame decoder — extracts individual frames as canvases
// Used to animate GIFs at variable speed on the game canvas

export async function decodeGif(url) {
    const resp = await fetch(url);
    const buffer = await resp.arrayBuffer();
    const data = new Uint8Array(buffer);
    let pos = 0;

    // Header
    const header = String.fromCharCode(...data.slice(0, 6));
    if (header !== 'GIF87a' && header !== 'GIF89a') throw new Error('Not a GIF');
    pos = 6;

    // Logical Screen Descriptor
    const width = data[pos] | (data[pos + 1] << 8); pos += 2;
    const height = data[pos] | (data[pos + 1] << 8); pos += 2;
    const packed = data[pos++];
    pos += 2; // bg color + aspect ratio

    const gctFlag = (packed >> 7) & 1;
    const gctSize = 2 << (packed & 7);

    let gct = null;
    if (gctFlag) {
        gct = [];
        for (let i = 0; i < gctSize; i++) {
            gct.push([data[pos++], data[pos++], data[pos++]]);
        }
    }

    const frames = [];
    let gce = null;

    // Compositing canvas
    const compCanvas = document.createElement('canvas');
    compCanvas.width = width;
    compCanvas.height = height;
    const compCtx = compCanvas.getContext('2d');

    while (pos < data.length) {
        const block = data[pos++];
        if (block === 0x3B) break; // Trailer

        if (block === 0x21) { // Extension
            const label = data[pos++];
            if (label === 0xF9) { // Graphic Control Extension
                pos++; // block size (always 4)
                const gcPacked = data[pos++];
                const delay = (data[pos] | (data[pos + 1] << 8)) * 10; pos += 2;
                const transparentIdx = data[pos++];
                gce = {
                    disposal: (gcPacked >> 2) & 7,
                    transparentFlag: gcPacked & 1,
                    transparentIdx,
                    delay: delay || 100,
                };
                pos++; // terminator
            } else {
                // Skip unknown extensions
                while (data[pos]) { pos += data[pos] + 1; }
                pos++; // terminator
            }
        } else if (block === 0x2C) { // Image Descriptor
            const left = data[pos] | (data[pos + 1] << 8); pos += 2;
            const top = data[pos] | (data[pos + 1] << 8); pos += 2;
            const w = data[pos] | (data[pos + 1] << 8); pos += 2;
            const h = data[pos] | (data[pos + 1] << 8); pos += 2;
            const imgPacked = data[pos++];

            const lctFlag = (imgPacked >> 7) & 1;
            const interlaced = (imgPacked >> 6) & 1;

            let lct = null;
            if (lctFlag) {
                const lctSize = 2 << (imgPacked & 7);
                lct = [];
                for (let i = 0; i < lctSize; i++) {
                    lct.push([data[pos++], data[pos++], data[pos++]]);
                }
            }

            const colorTable = lct || gct;

            // Read LZW data
            const minCodeSize = data[pos++];
            const lzwBytes = [];
            while (data[pos]) {
                const sz = data[pos++];
                for (let i = 0; i < sz; i++) lzwBytes.push(data[pos++]);
            }
            pos++; // terminator

            const pixels = lzwDecode(minCodeSize, lzwBytes, w * h);

            // Handle disposal
            const disposal = gce ? gce.disposal : 0;
            let prevData = null;
            if (disposal === 3) prevData = compCtx.getImageData(0, 0, width, height);
            if (disposal === 2) compCtx.clearRect(left, top, w, h);

            // Paint pixels onto compositing canvas
            const imgData = compCtx.getImageData(left, top, w, h);
            const transIdx = gce && gce.transparentFlag ? gce.transparentIdx : -1;

            for (let i = 0; i < pixels.length; i++) {
                const pi = pixels[i];
                if (pi === transIdx) continue;
                const color = colorTable[pi] || [0, 0, 0];

                let col = i % w;
                let row = interlaced ? deinterlace(Math.floor(i / w), h) : Math.floor(i / w);

                const di = (row * w + col) * 4;
                imgData.data[di] = color[0];
                imgData.data[di + 1] = color[1];
                imgData.data[di + 2] = color[2];
                imgData.data[di + 3] = 255;
            }
            compCtx.putImageData(imgData, left, top);

            // Snapshot this frame
            const frameCanvas = document.createElement('canvas');
            frameCanvas.width = width;
            frameCanvas.height = height;
            frameCanvas.getContext('2d').drawImage(compCanvas, 0, 0);
            frames.push({ canvas: frameCanvas, delay: gce ? gce.delay : 100 });

            if (disposal === 3 && prevData) compCtx.putImageData(prevData, 0, 0);
            gce = null;
        }
    }

    return frames;
}

function deinterlace(logicalRow, height) {
    const passes = [
        { start: 0, step: 8 }, { start: 4, step: 8 },
        { start: 2, step: 4 }, { start: 1, step: 2 },
    ];
    let row = 0;
    for (const pass of passes) {
        const count = Math.ceil((height - pass.start) / pass.step);
        if (logicalRow < row + count) return pass.start + (logicalRow - row) * pass.step;
        row += count;
    }
    return logicalRow;
}

function lzwDecode(minCodeSize, data, pixelCount) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let codeMask = (1 << codeSize) - 1;
    let nextCode = eoiCode + 1;

    const table = new Array(4096);
    for (let i = 0; i <= clearCode; i++) table[i] = [i];

    const output = [];
    let bitBuf = 0, bitCount = 0, dataPos = 0, prevCode = -1;

    function readCode() {
        while (bitCount < codeSize) {
            if (dataPos >= data.length) return -1;
            bitBuf |= data[dataPos++] << bitCount;
            bitCount += 8;
        }
        const code = bitBuf & codeMask;
        bitBuf >>= codeSize;
        bitCount -= codeSize;
        return code;
    }

    while (output.length < pixelCount) {
        const code = readCode();
        if (code === -1 || code === eoiCode) break;
        if (code === clearCode) {
            codeSize = minCodeSize + 1;
            codeMask = (1 << codeSize) - 1;
            nextCode = eoiCode + 1;
            prevCode = -1;
            continue;
        }

        let entry;
        if (code < nextCode) {
            entry = table[code];
        } else if (code === nextCode && prevCode !== -1) {
            entry = [...table[prevCode], table[prevCode][0]];
        } else break;

        for (let i = 0; i < entry.length; i++) output.push(entry[i]);

        if (prevCode !== -1 && nextCode < 4096) {
            table[nextCode++] = [...table[prevCode], entry[0]];
            if (nextCode > codeMask && codeSize < 12) {
                codeSize++;
                codeMask = (1 << codeSize) - 1;
            }
        }
        prevCode = code;
    }

    return output.slice(0, pixelCount);
}
