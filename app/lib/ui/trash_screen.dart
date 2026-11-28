import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/client.dart' show ApiException;
import '../state/app_controller.dart';
import 'admin_screen.dart';
import 'theme.dart';
import '../api/sync_api.dart';
import '../store/database.dart';
import 'widgets.dart';

/// Recycle bin. The mirror only holds live rows, so the bin view reads the
/// server via the ADMIN session channel (web-admin semantics — the paired
/// token would also be accepted server-side, but the app keeps destructive
/// maintenance on the admin plane) and restores/purges through it too.
/// NOT mirror data: refetches when the tab activates and whenever a sync
/// reconcile lands (dataEpoch). Locked until admin login.
class TrashScreen extends StatefulWidget {
  const TrashScreen({super.key, required this.active});

  /// Whether the shell currently shows this tab (IndexedStack keeps every
  /// tab alive, so state must react to activation explicitly).
  final bool active;

  @override
  State<TrashScreen> createState() => _TrashScreenState();
}

class _TrashScreenState extends State<TrashScreen> {
  List<Node>? _trash;
  int _seenEpoch = -1;
  bool _seenAdmin = false;
  bool _authRequired = false;
  String? _error;

  AppController get _app => context.read<AppController>();

  @override
  void initState() {
    super.initState();
    _seenEpoch = _app.dataEpoch;
    _seenAdmin = _app.adminLoggedIn;
    _app.addListener(_onAppChanged);
    _load();
  }

  @override
  void didUpdateWidget(TrashScreen old) {
    super.didUpdateWidget(old);
    if (widget.active && !old.active && _app.adminLoggedIn) _load();
  }

  @override
  void dispose() {
    _app.removeListener(_onAppChanged);
    super.dispose();
  }

  void _onAppChanged() {
    // admin login flips unlock the view immediately; logout re-locks
    if (_app.adminLoggedIn != _seenAdmin) {
      _seenAdmin = _app.adminLoggedIn;
      if (widget.active && _seenAdmin) _load();
      return;
    }
    if (!widget.active || !_app.adminLoggedIn || _app.dataEpoch == _seenEpoch) return;
    _seenEpoch = _app.dataEpoch;
    _load();
  }

  Future<void> _loginAndRetry() async {
    await Navigator.push(context, MaterialPageRoute(builder: (_) => const AdminScreen()));
    if (mounted && _app.adminLoggedIn) await _load();
  }

  Future<void> _load() async {
    if (!_app.adminLoggedIn) return;
    setState(() {
      _authRequired = false;
      _error = null;
    });
    try {
      final j = await _app.client.get('/api/trash', admin: true) as Map<String, dynamic>;
      final nodes = (j['nodes'] as List? ?? [])
          .map((n) => ServerBookmark.fromJson(n as Map<String, dynamic>))
          .toList();
      setState(() => _trash = [
            for (final n in nodes)
              Node(
                id: n.id,
                parentId: n.parentId,
                type: n.type,
                title: n.title,
                url: n.url,
                note: n.note,
                favorite: n.favorite,
                archived: n.archived,
                position: n.position,
                revision: n.revision,
                updatedAt: n.updatedAt,
                deviceId: n.deviceId,
                createdAt: n.createdAt,
                tags: '[]',
              ),
          ]);
    } on ApiException catch (e) {
      if (e.isAuth) await _app.logoutAdmin(notify: false);
      if (mounted) {
        setState(() {
          _authRequired = e.isAuth;
          _error = e.isAuth ? null : e.message;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppController>();
    final p = MdTheme.of(context);
    return Scaffold(
      backgroundColor: p.bg,
      // 无顶栏：底部导航已标明所在页
      body: SafeArea(
        bottom: false,
        child: !app.adminLoggedIn
          ? _locked(p)
          : _trash == null
              ? const Center(child: CircularProgressIndicator())
              : _authRequired
                  ? _authCard(p)
                  : _error != null
                      ? Center(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text('加载失败：$_error',
                                  style: TextStyle(color: p.danger, fontSize: 13)),
                              const SizedBox(height: 8),
                              TextButton(onPressed: _load, child: const Text('重试')),
                            ],
                          ),
                        )
                      : _trash!.isEmpty
                          ? Center(child: Text('回收站为空', style: TextStyle(color: p.text3)))
                          : RefreshIndicator(
                              onRefresh: _load,
                              child: ListView.builder(
                                itemCount: _trash!.length,
                                itemBuilder: (context, i) {
                                  final n = _trash![i];
                                  return ListTile(
                                    leading: n.type == 'folder'
                                        ? Icon(Icons.folder_off_outlined, color: p.text3)
                                        : BookmarkAvatar(url: n.url ?? '', title: n.title, size: 32),
                                    title: Text(n.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                                    subtitle: n.type == 'url'
                                        ? Text(n.url ?? '', maxLines: 1, overflow: TextOverflow.ellipsis)
                                        : null,
                                    trailing: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        IconButton(
                                          icon: const Icon(Icons.restore),
                                          tooltip: '恢复',
                                          onPressed: () => _restore(n),
                                        ),
                                        IconButton(
                                          icon: Icon(Icons.delete_forever, color: p.danger),
                                          tooltip: '彻底删除',
                                          onPressed: () => _purge(n),
                                        ),
                                      ],
                                    ),
                                  );
                                },
                              ),
                            ),
        ),
    );
  }

  Widget _locked(MdPalette p) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.lock_outline, size: 32, color: p.text3),
          const SizedBox(height: 10),
          Text('回收站需要管理员登录',
              style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600, color: p.text)),
          const SizedBox(height: 6),
          Text('回收站与恢复/彻底删除属于管理功能',
              style: TextStyle(fontSize: 12, color: p.text3)),
          const SizedBox(height: 14),
          FilledButton.icon(
            onPressed: _loginAndRetry,
            icon: const Icon(Icons.admin_panel_settings_outlined, size: 18),
            label: const Text('管理员登录'),
          ),
        ],
      ),
    );
  }

  Widget _authCard(MdPalette p) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.lock_outline, size: 32, color: p.text3),
          const SizedBox(height: 10),
          Text('管理员登录已过期',
              style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600, color: p.text)),
          const SizedBox(height: 14),
          FilledButton.icon(
            onPressed: _loginAndRetry,
            icon: const Icon(Icons.admin_panel_settings_outlined, size: 18),
            label: const Text('重新登录'),
          ),
        ],
      ),
    );
  }

  Future<void> _restore(Node n) async {
    try {
      await _app.client.post('/api/bookmarks/${n.id}/restore', body: {}, admin: true);
      await _load();
      await _app.driver.reconcile('restore');
    } on ApiException catch (e) {
      if (e.isAuth) {
        await _app.logoutAdmin(notify: false);
        if (mounted) setState(() => _authRequired = true);
      } else {
        _toast('恢复失败：${e.message}');
      }
    } catch (e) {
      _toast('恢复失败：$e');
    }
  }

  Future<void> _purge(Node n) async {
    try {
      await _app.client.post('/api/bookmarks/${n.id}/purge', admin: true);
      await _load();
    } on ApiException catch (e) {
      if (e.isAuth) {
        await _app.logoutAdmin(notify: false);
        if (mounted) setState(() => _authRequired = true);
      } else {
        _toast('删除失败：${e.message}');
      }
    } catch (e) {
      _toast('删除失败：$e');
    }
  }

  void _toast(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }
}

