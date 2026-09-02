package com.rabbah.rs232sample

import android.app.Activity
import android.graphics.Typeface
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.rabbah.mdb.HardwareLib
import com.rabbah.mdb.Rs232Lib
import kotlin.concurrent.thread

/**
 * RS232 test bench for hardware-lib's Rs232Lib - the whole rule workflow on buttons, results in
 * a live log. No MQTT, no MDB engine: just the RS232 API against the CM30 serial port.
 *
 *   1. LOAD RULES          - paste/edit the rule JSON and load it (persisted)
 *   2. baud + OPEN PORT    - start listening; every machine frame is matched + auto-replied
 *   3. SIMULATE RX         - test a rule WITHOUT the machine (feeds a fake frame through)
 *   4. SEND HEX            - manual TX, e.g. a vend approval frame
 *
 * Every [rs232] line the library reports lands in the log below the buttons - the same messages
 * the dashboard would see. Vend-request matches show ">> VEND REQUEST price=N".
 */
class MainActivity : Activity() {

    private lateinit var status: TextView
    private lateinit var logView: TextView
    private val log = StringBuilder()

    private fun logLine(line: String) {
        runOnUiThread {
            log.insert(0, line + "\n")
            if (log.length > 20_000) log.setLength(20_000)
            logView.text = log.toString()
        }
    }

    private fun refreshStatus() = runOnUiThread {
        val port = if (Rs232Lib.isOpen) "OPEN" else "closed"
        val ruleCount = try { org.json.JSONArray(Rs232Lib.rulesJson()).length() } catch (_: Throwable) { 0 }
        status.text = "hardware-lib ${HardwareLib.VERSION}\nport: $port | rules: $ruleCount/${Rs232Lib.MAX_RULES} | frame gap: ${Rs232Lib.frameGapMs}ms"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Rs232Lib.init(this)

        val pad = (resources.displayMetrics.density * 12).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }

        status = TextView(this).apply { typeface = Typeface.MONOSPACE; textSize = 13f }
        root.addView(status)

        fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        fun LinearLayout.button(label: String, onClick: () -> Unit) {
            addView(Button(this@MainActivity).apply {
                text = label
                setOnClickListener { onClick() }
            }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        }

        // --- rule table ---
        val rulesField = EditText(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 12f
            setHorizontallyScrolling(false)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            val saved = Rs232Lib.rulesJson()
            setText(
                if (saved != "[]") saved
                else """[
 {"name":"STATUS","rx":"FF FF FF FF FF","tx":"01 00"},
 {"name":"VEND_REQUEST","rx":"F1 05 ?? ?? 0D","tx":"06","priceHi":2,"priceLo":3}
]"""
            )
        }
        root.addView(rulesField)
        root.addView(row().apply {
            button("LOAD RULES") {
                val err = Rs232Lib.setRulesJson(rulesField.text.toString())
                logLine(if (err == null) "<< rules loaded OK" else "<< rules REJECTED: $err")
                refreshStatus()
            }
            button("GET RULES") { rulesField.setText(Rs232Lib.rulesJson()); logLine("<< current rules shown above") }
            button("CLEAR") { Rs232Lib.clearRules(); refreshStatus() }
        })

        // --- port ---
        val baudField = EditText(this).apply {
            hint = "baud"
            setText("9600")
            inputType = InputType.TYPE_CLASS_NUMBER
        }
        root.addView(row().apply {
            addView(baudField, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            button("OPEN PORT") {
                val baud = baudField.text.toString().toIntOrNull() ?: 9600
                thread {
                    val ok = Rs232Lib.open(baud = baud)
                    logLine("<< open returned $ok")
                    refreshStatus()
                }
            }
            button("CLOSE") { thread { Rs232Lib.close(); refreshStatus() } }
        })

        // --- simulate rx (rule test without the machine) ---
        val simField = EditText(this).apply {
            hint = "simulate machine frame, e.g. F1 05 01 F4 0D"
            setText("F1 05 01 F4 0D")
            typeface = Typeface.MONOSPACE
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        root.addView(simField)
        root.addView(row().apply {
            button("SIMULATE RX") { thread { Rs232Lib.simulateFrame(simField.text.toString()) } }
        })

        // --- manual tx ---
        val txField = EditText(this).apply {
            hint = "hex to send, e.g. 05 01 F4"
            setText("05 01 F4")
            typeface = Typeface.MONOSPACE
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        root.addView(txField)
        root.addView(row().apply {
            button("SEND HEX") {
                thread {
                    val ok = Rs232Lib.sendHex(txField.text.toString())
                    logLine("<< sendHex returned $ok")
                }
            }
        })

        logView = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 12f
            setPadding(0, pad, 0, 0)
        }
        root.addView(logView)

        setContentView(ScrollView(this).apply { addView(root, MATCH_PARENT, WRAP_CONTENT) })

        // Every [rs232] line the library reports shows up here - same text the dashboard gets.
        HardwareLib.addLogListener { line, _ -> logLine(line) }
        Rs232Lib.vendRequestListener = { price, frameHex ->
            logLine(">> VEND REQUEST price=$price frame=$frameHex")
        }

        logLine("-- rs232 test bench | hardware-lib ${HardwareLib.VERSION} --")
        logLine("1) LOAD RULES  2) OPEN PORT (or SIMULATE RX without machine)")
        refreshStatus()
    }
}
