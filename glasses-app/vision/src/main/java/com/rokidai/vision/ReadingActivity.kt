package com.rokidai.vision

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

// Проба чтения: сорок карточек со словом, по каждой владелец отмечает,
// разобрал он его или нет. Совместить две картинки очков программно нельзя
// (один источник изображения на оба глаза), поэтому подбираем то, что
// двоению поддаётся: размер букв, толщину и место на экране.
class ReadingActivity : Activity() {

    companion object {
        private const val BRIGHT = 0xFF45F068.toInt()
        private const val DIM = 0xFF2E9E46.toInt()
        private const val TRACK = 0xFF1C5A2C.toInt()
        private const val PANEL_HEIGHT = 320
        // Слово висит меньше полутора секунд: проба про «читается с одного
        // взгляда», а при бесконечном показе дочитать можно что угодно.
        private const val SHOW_MS = 1_300L
        private const val UI_SIZE = 22f
    }

    private enum class Stage { INTRO, SHOW, ASK, SENDING, RESULT, FAILED }

    private val plan = buildPlan()
    private val answers = mutableListOf<Answer>()
    private var index = 0
    private var stage = Stage.INTRO

    private val ui = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(Dispatchers.Main)
    private val toAsk = Runnable { ask() }

    private lateinit var panel: FrameLayout
    private lateinit var wordView: TextView
    private lateinit var titleView: TextView
    private lateinit var hintView: TextView
    private lateinit var progressBar: View

    private fun api(): VisionApi? {
        val url = BuildConfig.DEFAULT_URL.ifEmpty { return null }
        val token = BuildConfig.DEFAULT_TOKEN.ifEmpty { return null }
        return VisionApi(url, token)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        panel = FrameLayout(this).apply { setPadding(24, 88, 24, 16) }

        // Слово пробы: размер, толщину и место задаёт карточка.
        wordView = TextView(this).apply {
            setTextColor(BRIGHT)
            visibility = View.GONE
        }
        // Свой интерфейс рисуем заведомо крупно и жирно: подсказка, которую
        // самому не прочесть, обессмыслила бы пробу.
        titleView = TextView(this).apply {
            textSize = UI_SIZE
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(BRIGHT)
            gravity = Gravity.CENTER
        }
        hintView = TextView(this).apply {
            textSize = 14f
            setTextColor(DIM)
            gravity = Gravity.CENTER
        }
        val texts = FrameLayout(this)
        texts.addView(
            titleView,
            FrameLayout.LayoutParams(-1, -2, Gravity.CENTER),
        )
        texts.addView(
            hintView,
            FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL),
        )

        val track = View(this).apply { setBackgroundColor(TRACK) }
        progressBar = View(this).apply { setBackgroundColor(BRIGHT) }

        panel.addView(texts, FrameLayout.LayoutParams(-1, -1))
        panel.addView(wordView, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
        panel.addView(track, FrameLayout.LayoutParams(-1, 3, Gravity.BOTTOM))
        panel.addView(progressBar, FrameLayout.LayoutParams(0, 3, Gravity.BOTTOM))
        root.addView(panel, FrameLayout.LayoutParams(-1, PANEL_HEIGHT))
        setContentView(root)

        showIntro()
    }

    private fun showIntro() {
        stage = Stage.INTRO
        wordView.visibility = View.GONE
        titleView.text = "ПРОБА ЧТЕНИЯ"
        hintView.text = if (api() == null) "нет адреса сервера" else "${plan.size} карточек · клик — начать"
        updateProgress(0)
    }

    private fun updateProgress(done: Int) {
        panel.post {
            val width = panel.width - panel.paddingLeft - panel.paddingRight
            val lp = progressBar.layoutParams
            lp.width = if (plan.isEmpty()) 0 else width * done / plan.size
            progressBar.layoutParams = lp
        }
    }

    private fun showCard() {
        val card = plan[index]
        stage = Stage.SHOW
        titleView.text = ""
        hintView.text = ""
        wordView.apply {
            text = card.word
            textSize = card.size.toFloat()
            typeface = if (card.bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
            visibility = View.VISIBLE
            layoutParams = FrameLayout.LayoutParams(-2, -2, gravityFor(card.zone)).apply {
                if (card.zone == "bottom") bottomMargin = 16
            }
        }
        ui.removeCallbacks(toAsk)
        ui.postDelayed(toAsk, SHOW_MS)
    }

    private fun gravityFor(zone: String): Int = when (zone) {
        "top" -> Gravity.TOP or Gravity.CENTER_HORIZONTAL
        "bottom" -> Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
        "left" -> Gravity.CENTER_VERTICAL or Gravity.START
        "right" -> Gravity.CENTER_VERTICAL or Gravity.END
        else -> Gravity.CENTER
    }

    private fun ask() {
        stage = Stage.ASK
        wordView.visibility = View.GONE
        titleView.text = "ПРОЧИТАЛ?"
        hintView.text = "клик — да · назад — нет"
    }

    // Ответ принимается и во время показа слова: если разобрал сразу,
    // ждать конца показа незачем.
    private fun answer(read: Boolean) {
        // Отложенный переход к вопросу обязан сниматься здесь, иначе он
        // сработает уже поверх следующей карточки и собьёт её показ.
        ui.removeCallbacks(toAsk)
        val card = plan[index]
        answers.add(Answer(card.size, card.bold, card.zone, read))
        index++
        updateProgress(index)
        if (index < plan.size) showCard() else send()
    }

    private fun send() {
        val client = api() ?: run {
            stage = Stage.FAILED
            wordView.visibility = View.GONE
            titleView.text = "НЕТ НАСТРОЕК"
            hintView.text = "адрес сервера не задан при сборке"
            return
        }
        stage = Stage.SENDING
        wordView.visibility = View.GONE
        titleView.text = "СЧИТАЮ…"
        hintView.text = ""
        scope.launch(Dispatchers.IO) {
            val result = runCatching { client.report(answers) }
            scope.launch {
                result.fold(
                    onSuccess = { (title, text) ->
                        stage = Stage.RESULT
                        titleView.text = title
                        hintView.text = "$text\nклик — пройти заново"
                    },
                    onFailure = { error ->
                        stage = Stage.FAILED
                        titleView.text = "НЕТ СВЯЗИ"
                        hintView.text = "${error.message ?: "ошибка"}\nклик — отправить ещё раз"
                    },
                )
            }
        }
    }

    private fun restart() {
        answers.clear()
        index = 0
        showIntro()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_DPAD_CENTER -> {
                when (stage) {
                    Stage.INTRO -> if (plan.isNotEmpty()) showCard()
                    Stage.SHOW, Stage.ASK -> answer(read = true)
                    Stage.SENDING -> Unit
                    Stage.RESULT -> restart()
                    Stage.FAILED -> if (answers.size == plan.size) send() else restart()
                }
                return true
            }
            KeyEvent.KEYCODE_BACK -> {
                if (stage == Stage.SHOW || stage == Stage.ASK) {
                    answer(read = false)
                    return true
                }
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        super.onDestroy()
        ui.removeCallbacks(toAsk)
        scope.cancel()
    }
}
