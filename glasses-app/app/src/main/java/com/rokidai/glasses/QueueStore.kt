package com.rokidai.glasses

import java.io.File

// Офлайн-очередь: каждая заметка сначала сохраняется на диск и удаляется
// только после подтверждения сервера. Имя файла = recordingId, поэтому
// повторная досылка не создаёт дублей (сервер идемпотентен).
class QueueStore(private val dir: File) {

    fun add(wav: ByteArray): File {
        dir.mkdirs()
        val file = File(dir, "${System.currentTimeMillis()}.wav")
        val tmp = File(dir, "${file.name}.tmp")
        tmp.writeBytes(wav)
        tmp.renameTo(file)
        return file
    }

    fun pending(): List<File> =
        (dir.listFiles { f -> f.name.endsWith(".wav") } ?: emptyArray()).sortedBy { it.name }

    /** false — файл не удалился; вызывающий обязан прервать цикл досылки. */
    fun remove(file: File): Boolean = file.delete()
}
