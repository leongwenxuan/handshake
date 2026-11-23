// Wraps raw PCM (s16le, mono) in a 44-byte WAV header so Whisper can read it.
export function pcmToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

// Strips a WAV header if present, returning the raw PCM. Used by the bench script.
export function wavToPcm(wav: Buffer): Buffer {
  if (wav.subarray(0, 4).toString() !== 'RIFF') return wav
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString()
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') return wav.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size
  }
  throw new Error('WAV has no data chunk')
}
