package com.rokidai.glasses

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.view.KeyEvent

// Запасной путь на случай, если служба не поднята: кнопка гарнитуры приходит
// сюда broadcast'ом, а мы будим службу — открывать экран из приёмника нельзя,
// Android 12 такой запуск отклоняет.
class MediaButtonReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MEDIA_BUTTON) return
        // Вариант с классом появился только в Android 13, на очках Android 12.
        @Suppress("DEPRECATION")
        val event = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT)
        if (event?.action != KeyEvent.ACTION_DOWN) return
        context.startForegroundService(Intent(context, ListenerService::class.java))
    }
}
