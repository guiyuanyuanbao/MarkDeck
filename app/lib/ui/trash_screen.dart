import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_controller.dart';
import 'theme.dart';
import '../api/sync_api.dart';
import '../store/database.dart';
import 'widgets.dart';

/// Recycle bin. The server's trash lives server-side (GET /api/trash); the
/// app's mirror only holds live rows, so the bin view reads from the API
/// and restores/purges via the paired token. It is NOT mirror data, so it
/// refetches when the tab activates and whenever a sync reconcile lands
/// (dataEpoch) — otherwise the view would show the boot-time snapshot.
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

  AppController get _app => context.read<AppController>();

  @override
  void initState() {
    super.initState();
    _seenEpoch = _app.dataEpoch;
    _app.addListener(_onAppChanged);
    _load();
  }

  @override
  void didUpdateWidget(TrashScreen old) {
    super.didUpdateWidget(old);
    if (widget.active && !old.active) _load();
  }

  @override
  void dispose() {
    _app.removeListener(_onAppChanged);
    super.dispose();
  }

  void _onAppChanged() {
    if (!widget.active || _app.dataEpoch == _seenEpoch) return;
    _seenEpoch = _app.dataEpoch;
    _load();
  }

  Future<void> _load() async {
    // server trash needs the JSON shape of store.Bookmark; reuse the wire
    // decoder from the sync API layer through the paired client
    try {
      final j = await _app.client.get('/api/trash') as Map<String, dynamic>;
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
    } catch (_) {
      setState(() => _trash = []);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = MdTheme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('回收站')),
      body: _trash == null
          ? const Center(child: CircularProgressIndicator())
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
    );
  }

  Future<void> _restore(Node n) async {
    try {
      await _app.client.post('/api/bookmarks/${n.id}/restore', body: {});
      await _load();
      await _app.driver.reconcile('restore');
    } catch (e) {
      _toast('恢复失败：$e');
    }
  }

  Future<void> _purge(Node n) async {
    try {
      await _app.client.post('/api/bookmarks/${n.id}/purge');
      await _load();
    } catch (e) {
      _toast('删除失败：$e');
    }
  }

  void _toast(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }
}

