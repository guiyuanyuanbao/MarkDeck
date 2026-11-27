import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'state/app_controller.dart';
import 'ui/browse_screen.dart';
import 'ui/pair_screen.dart';
import 'ui/search_screen.dart';
import 'ui/settings_screen.dart';
import 'ui/tags_screen.dart';
import 'ui/tools_screen.dart';
import 'ui/trash_screen.dart';
import 'ui/edit_sheet.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(SystemUiOverlayStyle.dark);
  runApp(const MarkDeckApp());
}

class MarkDeckApp extends StatelessWidget {
  const MarkDeckApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      create: (_) => AppController()..boot(),
      child: Consumer<AppController>(
        builder: (context, app, _) {
          final dark = MediaQuery.platformBrightnessOf(context) == Brightness.dark;
          final scheme = ColorScheme.fromSeed(
            seedColor: const Color(0xFF3D6FE0),
            brightness: dark ? Brightness.dark : Brightness.light,
          );
          return MaterialApp(
            title: 'MarkDeck',
            theme: ThemeData(colorScheme: scheme, useMaterial3: true),
            home: app.booted
                ? (app.paired ? const HomeShell() : const PairScreen())
                : const BootingScreen(),
          );
        },
      ),
    );
  }
}

class BootingScreen extends StatelessWidget {
  const BootingScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(child: CircularProgressIndicator()),
    );
  }
}

/// Bottom-nav shell: browse / search / tags / trash / tools / settings.
/// Owns the lifecycle hooks (resume → reconcile, pause → stop WS) and the
/// ACTION_SEND share receiver (浏览器「分享 → MarkDeck」快速收藏).
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> with WidgetsBindingObserver {
  int _tab = 0;
  StreamSubscription<String>? _shareSub;

  static const _method = MethodChannel('markdeck/share');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _listenShares();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _shareSub?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final app = context.read<AppController>();
    switch (state) {
      case AppLifecycleState.resumed:
        app.onAppResume();
      case AppLifecycleState.paused:
      case AppLifecycleState.hidden:
        app.onAppPause();
      default:
        break;
    }
  }

  /// Share channel: cold-start queries takePendingShare once the engine is
  /// up; warm deliveries arrive via onShare events. Both funnel into the
  /// quick-save sheet.
  void _listenShares() {
    _method.setMethodCallHandler((call) async {
      if (call.method == 'onShare' && call.arguments is String) {
        _openQuickSave(call.arguments as String);
      }
      return null;
    });
    _method.invokeMethod<String>('takePendingShare').then((pending) {
      if (pending != null && pending.isNotEmpty) {
        _openQuickSave(pending);
      }
    }).catchError((_) {});
  }

  void _openQuickSave(String payload) {
    if (!mounted) return;
    final app = context.read<AppController>();
    if (!app.paired) return;
    // payload: [title]\n[url] — browsers send the URL; some add a title line
    final lines = payload.trim().split('\n');
    var url = '';
    var title = '';
    for (final line in lines) {
      final t = line.trim();
      if (t.isEmpty) continue;
      if (url.isEmpty && (t.startsWith('http://') || t.startsWith('https://'))) {
        url = t;
      } else if (title.isEmpty) {
        title = t;
      }
    }
    if (url.isEmpty) return;
    if (title.isEmpty) {
      try {
        title = Uri.parse(url).host;
      } on FormatException {
        title = url;
      }
    }
    showEditSheet(context, app.db, presetTitle: title, presetUrl: url);
  }

  @override
  Widget build(BuildContext context) {
    const screens = [
      BrowseScreen(),
      SearchScreen(),
      TagsScreen(),
      TrashScreen(),
      ToolsScreen(),
      SettingsScreen(),
    ];
    return Scaffold(
      body: IndexedStack(index: _tab, children: screens),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.folder_outlined),
            selectedIcon: Icon(Icons.folder),
            label: '书签',
          ),
          NavigationDestination(
            icon: Icon(Icons.search_outlined),
            selectedIcon: Icon(Icons.search),
            label: '搜索',
          ),
          NavigationDestination(
            icon: Icon(Icons.label_outline),
            selectedIcon: Icon(Icons.label),
            label: '标签',
          ),
          NavigationDestination(
            icon: Icon(Icons.delete_outline),
            selectedIcon: Icon(Icons.delete),
            label: '回收站',
          ),
          NavigationDestination(
            icon: Icon(Icons.build_outlined),
            selectedIcon: Icon(Icons.build),
            label: '工具',
          ),
          NavigationDestination(
            icon: Icon(Icons.settings_outlined),
            selectedIcon: Icon(Icons.settings),
            label: '设置',
          ),
        ],
      ),
    );
  }
}
