package com.rokidai.glasses

import okhttp3.Dns
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.UUID
import java.util.concurrent.TimeUnit

// Разговор с бэкендом: multipart POST audio → SSE-поток событий
// (user / status / answer / error / done) — контракт docs/glasses-protocol.md.
class ApiClient(private val baseUrl: String, private val token: String) {

    // DNS на очках бывает сломан («unable to resolve host»): если системный
    // резолвер не справился с нашим хостом — подставляем известный IP.
    // TLS-сертификат при этом всё равно проверяется по имени хоста.
    private val dnsWithFallback = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> = try {
            Dns.SYSTEM.lookup(hostname)
        } catch (e: UnknownHostException) {
            if (BuildConfig.FALLBACK_IP.isNotEmpty()) {
                listOf(InetAddress.getByAddress(hostname, ipToBytes(BuildConfig.FALLBACK_IP)))
            } else {
                throw e
            }
        }
    }

    private fun ipToBytes(ip: String): ByteArray =
        ip.split(".").map { it.toInt().toByte() }.toByteArray()

    private val client = OkHttpClient.Builder()
        .dns(dnsWithFallback)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(50, TimeUnit.SECONDS)
        .build()

    fun ping(): Boolean = runCatching {
        val request = Request.Builder().url("$baseUrl/").get().build()
        client.newCall(request).execute().use { it.isSuccessful }
    }.getOrDefault(false)

    /** Блокирующий вызов: события отдаются в callback по мере прихода. */
    fun chat(wav: ByteArray, recordingId: String = UUID.randomUUID().toString(), onEvent: (type: String, text: String) -> Unit) {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("audio", "audio.wav", wav.toRequestBody("audio/wav".toMediaType()))
            .addFormDataPart("recordingId", recordingId)
            .build()
        val request = Request.Builder()
            .url("$baseUrl/glasses/chat")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                onEvent("error", "Сервер ответил HTTP ${response.code}")
                return
            }
            val source = response.body?.source() ?: return
            while (!source.exhausted()) {
                val line = source.readUtf8Line() ?: break
                if (!line.startsWith("data: ")) continue
                val event = JSONObject(line.removePrefix("data: "))
                val type = event.optString("type")
                onEvent(type, event.optString("text"))
                if (type == "done") break
            }
        }
    }
}
