package com.rokidai.glasses

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// Заливка настроек без UI (схема rode):
// adb shell am broadcast -a com.rokidai.glasses.SET_CONFIG \
//   --es url "https://api.aifirst.us.com:8444/rokid" --es token "<INBOX_TOKEN>"
class ConfigReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val url = intent.getStringExtra("url") ?: return
        val token = intent.getStringExtra("token") ?: return
        if (!url.startsWith("https://")) return
        context.getSharedPreferences("config", Context.MODE_PRIVATE)
            .edit()
            .putString("url", url.trimEnd('/'))
            .putString("token", token)
            .apply()
    }
}
