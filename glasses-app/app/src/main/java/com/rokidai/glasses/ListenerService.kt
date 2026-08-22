package com.rokidai.glasses

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.media.session.MediaSession
import android.os.IBinder
import android.view.KeyEvent

// Фоновая служба «всегда наготове»: держит медиа-сессию, чтобы нажатие кнопки
// долетало до нас, даже когда экран приложения закрыт, и по нажатию открывает
// экран заметки — запись там стартует сама. Так приложением можно пользоваться
// как агентом: не надо искать иконку в меню.
class ListenerService : Service() {

    private companion object {
        const val CHANNEL_ID = "rokidai-listener"
        const val CHANNEL_LAUNCH = "rokidai-launch"
        const val NOTIFICATION_ID = 1
        const val LAUNCH_NOTIFICATION_ID = 2
    }

    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        createChannels()
        startForeground(NOTIFICATION_ID, readyNotification())
        session = MediaSession(this, "rokidai").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onMediaButtonEvent(intent: Intent): Boolean {
                    // Вариант с классом появился только в Android 13, на очках Android 12.
                    @Suppress("DEPRECATION")
                    val event = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT)
                    if (event?.action == KeyEvent.ACTION_DOWN) openNote("кнопка ${event.keyCode}")
                    return true
                }
            })
            isActive = true
        }
    }

    private fun createChannels() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Инбокс наготове", NotificationManager.IMPORTANCE_MIN),
        )
        // Полноэкранное уведомление показывается только из «важного» канала.
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_LAUNCH, "Открытие заметки", NotificationManager.IMPORTANCE_HIGH),
        )
    }

    private fun readyNotification(): Notification =
        Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Инбокс наготове")
            .setContentText("Нажми кнопку — начну запись")
            .setSmallIcon(R.drawable.ic_mic)
            .setContentIntent(noteIntent("значок"))
            .build()

    private fun noteIntent(trigger: String): PendingIntent {
        val launch = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(MainActivity.EXTRA_TRIGGER, trigger)
        return PendingIntent.getActivity(
            this,
            trigger.hashCode(),
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    // Android 12 запрещает открывать экран из фона напрямую — такой вызов
    // система молча отклоняет. Разрешённый путь — «полноэкранное» уведомление:
    // оно выводит экран заметки само.
    private fun openNote(trigger: String) {
        val notification = Notification.Builder(this, CHANNEL_LAUNCH)
            .setContentTitle("Заметка")
            .setContentText("Открываю запись")
            .setSmallIcon(R.drawable.ic_mic)
            .setCategory(Notification.CATEGORY_CALL)
            .setFullScreenIntent(noteIntent(trigger), true)
            .setAutoCancel(true)
            .build()
        getSystemService(NotificationManager::class.java)
            .notify(LAUNCH_NOTIFICATION_ID, notification)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        session?.isActive = false
        session?.release()
        session = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
