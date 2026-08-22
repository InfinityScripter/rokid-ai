package com.rokidai.glasses

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// После включения очков поднимаем службу «наготове», а не сам экран: заметку
// открывает нажатие кнопки, а не загрузка устройства.
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        context.startForegroundService(Intent(context, ListenerService::class.java))
    }
}
