package dev.ace.uihelper;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * ace's long-running Android UI tree reader. Started by the daemon with
 * `app_process / dev.ace.uihelper.Main` as the shell user, it keeps one UiAutomation connection
 * and answers each `tree` line on stdin with one line on stdout: `OK ` and the tree in
 * uiautomator's dump XML (newlines escaped), or `ERR ` and a reason. Closing stdin ends it and
 * releases UiAutomation for other tools.
 */
public final class Main {
    private static final int MAX_NODES = 32768;
    private static final int MAX_DEPTH = 128;

    private Main() {
    }

    public static void main(String[] args) throws Exception {
        // The accessibility client posts to the main looper, which app_process does not create.
        Looper.prepareMainLooper();
        HandlerThread thread = new HandlerThread("ace-ui-helper");
        thread.start();
        UiAutomation automation = connect(thread.getLooper());
        AccessibilityServiceInfo info = automation.getServiceInfo();
        if (info != null) {
            info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
                    | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                    | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
            automation.setServiceInfo(info);
        }
        Thread requests = new Thread(() -> {
            try {
                serve(automation);
            } catch (Throwable ignored) {
                // stdout or stdin is gone: the daemon has stopped listening.
            }
            disconnect(automation);
            System.exit(0);
        }, "ace-ui-requests");
        requests.start();
        Looper.loop();
    }

    private static void serve(UiAutomation automation) throws Exception {
        OutputStream out = System.out;
        out.write("READY\n".getBytes(StandardCharsets.UTF_8));
        out.flush();
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            String reply;
            if (line.equals("tree")) {
                try {
                    reply = "OK " + dump(automation);
                } catch (Throwable error) {
                    reply = "ERR " + oneLine(String.valueOf(error));
                }
            } else {
                reply = "ERR unknown request";
            }
            out.write((reply + "\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
        }
    }

    /** UiAutomation's shell constructor and connect are hidden; app_process may call them. */
    private static UiAutomation connect(Looper looper) throws Exception {
        Class<?> connectionClass = Class.forName("android.app.UiAutomationConnection");
        Class<?> connectionInterface = Class.forName("android.app.IUiAutomationConnection");
        Object connection = connectionClass.getDeclaredConstructor().newInstance();
        Constructor<UiAutomation> constructor =
                UiAutomation.class.getDeclaredConstructor(Looper.class, connectionInterface);
        constructor.setAccessible(true);
        UiAutomation automation = constructor.newInstance(looper, connection);
        try {
            Method connect = UiAutomation.class.getDeclaredMethod("connect", int.class);
            connect.setAccessible(true);
            // Keep the user's own accessibility services (TalkBack) running.
            connect.invoke(automation, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        } catch (NoSuchMethodException old) {
            Method connect = UiAutomation.class.getDeclaredMethod("connect");
            connect.setAccessible(true);
            connect.invoke(automation);
        }
        return automation;
    }

    private static void disconnect(UiAutomation automation) {
        try {
            Method disconnect = UiAutomation.class.getDeclaredMethod("disconnect");
            disconnect.setAccessible(true);
            disconnect.invoke(automation);
        } catch (Throwable ignored) {
            // The process is ending; the system drops the connection with it.
        }
    }

    private static String dump(UiAutomation automation) {
        StringBuilder xml = new StringBuilder(64 * 1024);
        xml.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">");
        int[] count = {0};
        List<AccessibilityWindowInfo> windows = automation.getWindows();
        boolean any = false;
        if (windows != null) {
            // Bottom window first, matching the order uiautomator writes them.
            for (int index = windows.size() - 1; index >= 0; index--) {
                AccessibilityNodeInfo root = windows.get(index).getRoot();
                if (root == null) {
                    continue;
                }
                any = true;
                node(xml, root, 0, 0, count);
            }
        }
        if (!any) {
            AccessibilityNodeInfo root = automation.getRootInActiveWindow();
            if (root == null) {
                throw new IllegalStateException("null root node");
            }
            node(xml, root, 0, 0, count);
        }
        xml.append("</hierarchy>");
        return xml.toString();
    }

    private static void node(StringBuilder xml, AccessibilityNodeInfo node, int index, int depth, int[] count) {
        if (++count[0] > MAX_NODES || depth > MAX_DEPTH) {
            return;
        }
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        xml.append("<node");
        attribute(xml, "index", String.valueOf(index));
        attribute(xml, "text", node.getText());
        attribute(xml, "resource-id", node.getViewIdResourceName());
        attribute(xml, "class", node.getClassName());
        attribute(xml, "package", node.getPackageName());
        attribute(xml, "content-desc", node.getContentDescription());
        attribute(xml, "checkable", String.valueOf(node.isCheckable()));
        attribute(xml, "checked", String.valueOf(node.isChecked()));
        attribute(xml, "clickable", String.valueOf(node.isClickable()));
        attribute(xml, "enabled", String.valueOf(node.isEnabled()));
        attribute(xml, "focusable", String.valueOf(node.isFocusable()));
        attribute(xml, "focused", String.valueOf(node.isFocused()));
        attribute(xml, "scrollable", String.valueOf(node.isScrollable()));
        attribute(xml, "long-clickable", String.valueOf(node.isLongClickable()));
        attribute(xml, "password", String.valueOf(node.isPassword()));
        attribute(xml, "selected", String.valueOf(node.isSelected()));
        attribute(xml, "bounds", "[" + Math.max(0, bounds.left) + "," + Math.max(0, bounds.top) + "]["
                + Math.max(Math.max(0, bounds.left), bounds.right) + ","
                + Math.max(Math.max(0, bounds.top), bounds.bottom) + "]");
        int children = node.getChildCount();
        if (children == 0) {
            xml.append("/>");
            return;
        }
        xml.append(">");
        int written = 0;
        for (int child = 0; child < children; child++) {
            AccessibilityNodeInfo next = node.getChild(child);
            if (next == null) {
                continue;
            }
            if (next.isVisibleToUser()) {
                node(xml, next, written++, depth + 1, count);
            }
        }
        xml.append("</node>");
    }

    private static void attribute(StringBuilder xml, String name, CharSequence value) {
        xml.append(' ').append(name).append("=\"");
        if (value != null) {
            escape(xml, value);
        }
        xml.append('"');
    }

    /** XML-escapes text; control characters and unpaired surrogates become character references. */
    private static void escape(StringBuilder xml, CharSequence value) {
        for (int index = 0; index < value.length(); index++) {
            char c = value.charAt(index);
            if (Character.isHighSurrogate(c) && index + 1 < value.length()
                    && Character.isLowSurrogate(value.charAt(index + 1))) {
                xml.append(c).append(value.charAt(++index));
            } else if (Character.isSurrogate(c)) {
                xml.append("&#65533;");
            } else if (c == '&') {
                xml.append("&amp;");
            } else if (c == '<') {
                xml.append("&lt;");
            } else if (c == '>') {
                xml.append("&gt;");
            } else if (c == '"') {
                xml.append("&quot;");
            } else if (c < 0x20) {
                xml.append("&#").append((int) c).append(';');
            } else {
                xml.append(c);
            }
        }
    }

    private static String oneLine(String text) {
        return text.replace('\n', ' ').replace('\r', ' ');
    }
}
