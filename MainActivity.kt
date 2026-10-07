package com.mycompany.soomaalink

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Message
import android.provider.MediaStore
import android.util.Base64
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : AppCompatActivity() {

    companion object {
        const val START_URL = "https://liibojo.github.io/soomaalink/"
        const val HOST = "liibojo.github.io"
    }

    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingWebPermission: PermissionRequest? = null

    // Camera / microphone runtime permissions
    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        pendingWebPermission?.let { grantWebPermission(it) }
        pendingWebPermission = null
    }

    // File picker / camera capture for <input type="file">
    private val fileLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { res ->
        val data = res.data
        val uris: Array<Uri>? = if (res.resultCode == RESULT_OK) {
            WebChromeClient.FileChooserParams.parseResult(res.resultCode, data)
                ?: data?.data?.let { arrayOf(it) }
        } else null
        fileCallback?.onReceiveValue(uris)
        fileCallback = null
    }

    private fun has(p: String) =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun grantWebPermission(req: PermissionRequest) {
        val ok = req.resources.filter { r ->
            (r == PermissionRequest.RESOURCE_VIDEO_CAPTURE && has(Manifest.permission.CAMERA)) ||
            (r == PermissionRequest.RESOURCE_AUDIO_CAPTURE && has(Manifest.permission.RECORD_AUDIO))
        }
        if (ok.isEmpty()) req.deny() else req.grant(ok.toTypedArray())
    }

    private fun openExternal(u: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, u))
        } catch (e: Exception) {
            Toast.makeText(this, "No app found", Toast.LENGTH_SHORT).show()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        web = WebView(this)
        web.setBackgroundColor(Color.BLACK)
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(
                web,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
        }
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime()
            )
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
        WindowCompat.getInsetsController(window, root).isAppearanceLightStatusBars = false

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true          // localStorage + IndexedDB (your videos)
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = true
            allowContentAccess = true
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        web.addJavascriptInterface(Bridge(), "AndroidBridge")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?, request: WebResourceRequest?
            ): Boolean {
                val u = request?.url ?: return false
                if (u.host == HOST) return false
                openExternal(u)           // WhatsApp, Telegram, mailto ... open in their apps
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {

            override fun onPermissionRequest(request: PermissionRequest?) {
                val req = request ?: return
                runOnUiThread {
                    if (req.origin.host != HOST) { req.deny(); return@runOnUiThread }
                    val needs = mutableListOf<String>()
                    for (r in req.resources) {
                        if (r == PermissionRequest.RESOURCE_VIDEO_CAPTURE) needs.add(Manifest.permission.CAMERA)
                        if (r == PermissionRequest.RESOURCE_AUDIO_CAPTURE) needs.add(Manifest.permission.RECORD_AUDIO)
                    }
                    val missing = needs.filter { !has(it) }
                    if (missing.isEmpty()) {
                        grantWebPermission(req)
                    } else {
                        pendingWebPermission = req
                        permLauncher.launch(missing.toTypedArray())
                    }
                }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val wantsVideoCapture = params != null && params.isCaptureEnabled &&
                        params.acceptTypes.any { it.startsWith("video") }
                val intent: Intent = if (wantsVideoCapture) {
                    Intent(MediaStore.ACTION_VIDEO_CAPTURE).putExtra(MediaStore.EXTRA_DURATION_LIMIT, 60)
                } else {
                    params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE); type = "video/*"
                    }
                }
                return try {
                    fileLauncher.launch(intent); true
                } catch (e: Exception) {
                    fileCallback = null
                    callback?.onReceiveValue(null)
                    false
                }
            }

            // window.open(...) (share links) -> open in the proper external app
            override fun onCreateWindow(
                view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?
            ): Boolean {
                val msg = resultMsg ?: return false
                val tmp = WebView(this@MainActivity)
                tmp.webViewClient = object : WebViewClient() {
                    private var done = false
                    private fun go(u: Uri?) {
                        if (!done && u != null) {
                            done = true
                            openExternal(u)
                            tmp.post { tmp.destroy() }
                        }
                    }
                    override fun shouldOverrideUrlLoading(v: WebView?, r: WebResourceRequest?): Boolean {
                        go(r?.url); return true
                    }
                    override fun onPageStarted(v: WebView?, url: String?, favicon: Bitmap?) {
                        go(url?.let { Uri.parse(it) })
                    }
                }
                (msg.obj as WebView.WebViewTransport).webView = tmp
                msg.sendToTarget()
                return true
            }
        }

        // Downloads (including blob: videos created by the app) -> Downloads folder
        web.setDownloadListener { url, _, _, mime, _ ->
            if (url.startsWith("blob:")) {
                val m = if (mime.isNullOrBlank()) "video/webm" else mime
                val ext = if (m.contains("mp4")) "mp4" else "webm"
                val js = "(function(){var x=new XMLHttpRequest();x.open('GET','$url',true);" +
                        "x.responseType='blob';x.onload=function(){var r=new FileReader();" +
                        "r.onloadend=function(){AndroidBridge.saveFile(r.result.split(',')[1],'$m'," +
                        "'soomaalink-'+Date.now()+'.$ext');};r.readAsDataURL(x.response);};x.send();})();"
                web.evaluateJavascript(js, null)
            } else {
                openExternal(Uri.parse(url))
            }
        }

        // Back button: let the web app close its screens first
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript(
                    "(function(){return window.appBack?window.appBack():false})()"
                ) { r ->
                    if (r != "true") {
                        if (web.canGoBack()) web.goBack() else finish()
                    }
                }
            }
        })

        // Ask camera + microphone once at start (needed for recording and LIVE)
        val need = listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO).filter { !has(it) }
        if (need.isNotEmpty()) permLauncher.launch(need.toTypedArray())

        val start = intent?.data?.takeIf { it.host == HOST }?.toString() ?: START_URL
        web.loadUrl(start)
    }

    // Opening a SoomaaLink LIVE link while the app is already running
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.let { if (it.host == HOST) web.loadUrl(it.toString()) }
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    inner class Bridge {
        @JavascriptInterface
        fun saveFile(b64: String, mime: String, name: String) {
            try {
                val bytes = Base64.decode(b64, Base64.DEFAULT)
                val cv = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, mime.substringBefore(';'))
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv)!!
                contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "✅ $name → Downloads", Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                runOnUiThread {
                    Toast.makeText(this@MainActivity, "Download failed", Toast.LENGTH_LONG).show()
                }
            }
        }
    }
}
