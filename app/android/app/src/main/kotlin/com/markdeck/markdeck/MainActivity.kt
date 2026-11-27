package com.markdeck.markdeck

import android.content.Intent
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/// Host activity: forwards ACTION_SEND shares (浏览器「分享 → MarkDeck」)
/// into Flutter via a MethodChannel. Handles cold start (onCreate getIntent)
/// and warm delivery (onNewIntent — singleTop launch mode).
class MainActivity : FlutterActivity() {
    private var pendingShare: String? = null
    private var channel: MethodChannel? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "markdeck/share")
        channel?.setMethodCallHandler { call, result ->
            when (call.method) {
                "takePendingShare" -> {
                    result.success(pendingShare)
                    pendingShare = null
                }
                else -> result.notImplemented()
            }
        }
        // engine ready AFTER onCreate delivered the share: flush now
        pendingShare?.let { shared ->
            channel?.invokeMethod("onShare", shared)
            pendingShare = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        extractShare(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        extractShare(intent)
    }

    private fun extractShare(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
        if (text.isBlank()) return
        val title = intent.getStringExtra(Intent.EXTRA_TITLE)
        val payload = if (!title.isNullOrBlank() && text != title) "$title\n$text" else text
        pendingShare = payload
        // deliver if Dart is listening; otherwise configureFlutterEngine flushes
        channel?.invokeMethod("onShare", payload)
        pendingShare = null
    }
}
