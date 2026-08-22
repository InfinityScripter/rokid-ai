package com.rokidai.vision

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper

// Напоминание о перерывах — единственное из «упражнений для глаз», у чего есть
// приличная доказательная база: каждые 20 минут посмотреть вдаль секунд на 20.
// Причина усталости — редкое моргание за экраном, поэтому во втором напоминании
// про моргание говорится прямо.
class BreakService : Service() {

    companion object {
        const val INTERVAL_MS = 20 * 60 * 1000L

        private const val CHANNEL_ALIVE = "breaks-alive"
        private const val CHANNEL_REMIND = "breaks-remind"
        private const val ALIVE_ID = 41
        private const val REMIND_ID = 42

        // Служба живёт своей жизнью, а экран приложения — своей, поэтому
        // состояние спрашиваем у самой службы.
        @Volatile
        var running = false
            private set

        fun toggle(context: Context): Boolean {
            val intent = Intent(context, BreakService::class.java)
            val turnOn = !running
            if (turnOn) context.startForegroundService(intent) else context.stopService(intent)
            // Флаг переставляем сразу: служба стартует не мгновенно, и экран,
            // который спросит состояние следующей строкой, показал бы старое.
            running = turnOn
            return turnOn
        }
    }

    private val ui = Handler(Looper.getMainLooper())
    private var remindersSent = 0

    private val tick = object : Runnable {
        override fun run() {
            remindersSent++
            remind()
            ui.postDelayed(this, INTERVAL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ALIVE, "Перерывы", NotificationManager.IMPORTANCE_MIN),
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_REMIND, "Напоминание", NotificationManager.IMPORTANCE_HIGH),
        )
        startForeground(
            ALIVE_ID,
            Notification.Builder(this, CHANNEL_ALIVE)
                .setContentTitle("Перерывы включены")
                .setContentText("напомню каждые 20 минут")
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .build(),
        )
        running = true
        ui.postDelayed(tick, INTERVAL_MS)
    }

    private fun remind() {
        val text = if (remindersSent % 2 == 0) {
            "Посмотри вдаль 20 секунд"
        } else {
            "Посмотри вдаль и поморгай"
        }
        getSystemService(NotificationManager::class.java).notify(
            REMIND_ID,
            Notification.Builder(this, CHANNEL_REMIND)
                .setContentTitle("Перерыв")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setAutoCancel(true)
                .setTimeoutAfter(60_000)
                .build(),
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        super.onDestroy()
        ui.removeCallbacks(tick)
        running = false
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
