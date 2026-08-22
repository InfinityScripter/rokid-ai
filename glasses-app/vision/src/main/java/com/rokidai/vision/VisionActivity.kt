package com.rokidai.vision

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

// Главный экран: подгонка очков под глаза, напоминание о перерывах и проба
// чтения. Свести две картинки программно нельзя — у очков один источник
// изображения на оба глаза, — поэтому приложение занимается тем, что реально
// влияет на двоение: посадкой оправы, отдыхом и размером текста.
class VisionActivity : Activity() {

    companion object {
        private const val BRIGHT = 0xFF45F068.toInt()
        private const val DIM = 0xFF2E9E46.toInt()
        private const val PANEL_HEIGHT = 320
        // Замер на макете 480×640: выше 130 шаг мастера не влезает в видимую
        // верхнюю половину экрана, а по ширине место есть.
        private const val TARGET_WIDTH = 300
        private const val TARGET_HEIGHT = 130
    }

    private enum class Screen { MENU, FIT, RESULT }

    private enum class MenuItem(val title: String) {
        FIT("ПОДГОНКА"),
        BREAKS("ПЕРЕРЫВЫ"),
        READING("ПРОБА ЧТЕНИЯ"),
    }

    private val wizard = FitWizard()
    private var screen = Screen.MENU
    private var menuItem = MenuItem.FIT

    private lateinit var titleView: TextView
    private lateinit var hintView: TextView
    private lateinit var target: TargetView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(24, 88, 24, 16)
        }

        titleView = TextView(this).apply {
            textSize = 22f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(BRIGHT)
            gravity = Gravity.CENTER
        }
        target = TargetView(this).apply { visibility = View.GONE }
        hintView = TextView(this).apply {
            textSize = 14f
            setTextColor(DIM)
            gravity = Gravity.CENTER
        }

        panel.addView(titleView, LinearLayout.LayoutParams(-1, -2))
        panel.addView(
            target,
            LinearLayout.LayoutParams(TARGET_WIDTH, TARGET_HEIGHT).apply { topMargin = 6; bottomMargin = 6 },
        )
        panel.addView(hintView, LinearLayout.LayoutParams(-1, -2))
        root.addView(panel, FrameLayout.LayoutParams(-1, PANEL_HEIGHT))
        setContentView(root)

        showMenu()
    }

    // Возвращаясь из пробы чтения, экран должен показывать меню, а не то,
    // на чём его оставили.
    override fun onResume() {
        super.onResume()
        if (screen == Screen.MENU) showMenu()
    }

    private fun showMenu() {
        screen = Screen.MENU
        target.visibility = View.GONE
        titleView.text = menuItem.title
        hintView.text = when (menuItem) {
            MenuItem.BREAKS ->
                "${if (BreakService.running) "включены" else "выключены"}\nклик — переключить · назад — дальше"
            else -> "клик — начать · назад — дальше"
        }
    }

    private fun showStep() {
        screen = Screen.FIT
        val step = wizard.step
        titleView.text = step.title
        hintView.text = step.hint
        target.visibility = if (step.showTarget) View.VISIBLE else View.GONE
    }

    private fun showResult() {
        screen = Screen.RESULT
        target.visibility = View.GONE
        val advice = wizard.advice()
        titleView.text = advice.title
        hintView.text = "${advice.text}\n\nклик — в меню"
    }

    private fun answerStep(yes: Boolean) {
        if (wizard.answer(yes)) showResult() else showStep()
    }

    private fun startMenuItem() {
        when (menuItem) {
            MenuItem.FIT -> {
                wizard.reset()
                showStep()
            }
            MenuItem.BREAKS -> {
                BreakService.toggle(this)
                showMenu()
            }
            MenuItem.READING -> startActivity(Intent(this, ReadingActivity::class.java))
        }
    }

    // Кнопка одна: клик — «да» или действие, «назад» — «нет» или следующий
    // пункт меню.
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_DPAD_CENTER -> {
                when (screen) {
                    Screen.MENU -> startMenuItem()
                    Screen.FIT -> answerStep(yes = true)
                    Screen.RESULT -> showMenu()
                }
                return true
            }
            KeyEvent.KEYCODE_BACK -> {
                when (screen) {
                    Screen.MENU -> {
                        val items = MenuItem.entries
                        menuItem = items[(items.indexOf(menuItem) + 1) % items.size]
                        showMenu()
                    }
                    Screen.FIT -> answerStep(yes = false)
                    Screen.RESULT -> showMenu()
                }
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }
}
