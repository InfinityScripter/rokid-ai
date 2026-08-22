package com.rokidai.vision

import okhttp3.Dns
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

// Отправка ответов на сервер: считает и хранит профиль он, очки только
// показывают вердикт. Так арифметику можно прогнать и проверить на машине,
// а не гадать по экрану очков.
class VisionApi(private val baseUrl: String, private val token: String) {

    // На очках системный DNS иногда не резолвит наш хост — тогда идём по
    // известному адресу, сертификат при этом всё равно проверяется по имени.
    private val dnsWithFallback = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> = try {
            Dns.SYSTEM.lookup(hostname)
        } catch (e: UnknownHostException) {
            if (BuildConfig.FALLBACK_IP.isNotEmpty()) {
                listOf(InetAddress.getByAddress(hostname, BuildConfig.FALLBACK_IP.split(".").map { it.toInt().toByte() }.toByteArray()))
            } else {
                throw e
            }
        }
    }

    private val client = OkHttpClient.Builder()
        .dns(dnsWithFallback)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /** Блокирующий вызов. Возвращает пару «заголовок, подпись» для экрана. */
    fun report(answers: List<Answer>): Pair<String, String> {
        val array = JSONArray()
        for (a in answers) {
            array.put(
                JSONObject()
                    .put("size", a.size)
                    .put("bold", a.bold)
                    .put("zone", a.zone)
                    .put("read", a.read),
            )
        }
        val body = JSONObject().put("answers", array).toString()
        val request = Request.Builder()
            .url("$baseUrl/vision/report")
            .header("Authorization", "Bearer $token")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw java.io.IOException("HTTP ${response.code}")
            val json = JSONObject(text)
            return json.optString("title", "ГОТОВО") to json.optString("text", "")
        }
    }
}
