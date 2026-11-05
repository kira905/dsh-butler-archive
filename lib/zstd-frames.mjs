/**
 * dsh-butler-archive / lib/zstd-frames.mjs
 *
 * zstd **多帧**日志的帧边界扫描（严格结构解析）。
 *
 * 为什么需要它：会话日志（`session.jsonl.zstd` / `session.v3.jsonl.zstd`）是多帧追加写的
 * —— 一帧 ≈ 一次 flush 的一批事件。要取首帧/尾帧，就必须先把多帧缓冲切成逐帧。
 *
 * 算法（严格结构解析，**不用"魔数搜索"那套启发式**）：
 *   ZSTD magic（0xFD2FB528 LE）→ frame header descriptor（含 dictionary / content-size 字段宽度）
 *   → block 循环（block type 3 = reserved ⇒ 断）→ 可选 4 字节 checksum；
 *   遇**不完整帧**返回 `tornStart`（该帧起点）——**不猜长度、也不把残字节当完整帧**。
 * 启发式的两个弱点在这里都不存在：
 *   ① 压缩数据里恰好出现 zstd magic 字节序列时，会把一帧切成两半；
 *   ② 多份实现各自演化 ⇒ 一处修另一处不跟。
 *
 * 零依赖：只用 node 标准库（调用方自己做解压）。
 */

export const ZSTD_MAGIC = 4247762216 // 0xFD2FB528 LE

/**
 * 扫描 zstd 多帧边界。
 * @param {Buffer} buffer 整个多帧缓冲（调用方负责截断/切片）
 * @returns {{frames: {start:number,end:number}[], tornStart: number|undefined}}
 *   frames    —— **完整帧**的 [start, end) 区间，顺序即文件内顺序；
 *   tornStart —— 第一个**不完整**帧的起点（没有 = undefined）。调用方须"遇撕裂不猜"：
 *                撕裂帧一律丢弃，绝不把残字节当完整帧去解。
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: start }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return { frames, tornStart: start }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return { frames, tornStart: start }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, tornStart: undefined }
}
