import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'client.dart';

/// Sync-plane API surface: full tree fetch + batch apply (device-token only
/// routes on the server) plus the WS revision feed. Mirrors docs/protocol.md.
class SyncApi {
  SyncApi(this._client);

  final ApiClient _client;

  /// GET /api/sync/tree -> {head, othersId, nodes:[Bookmark]}
  Future<SyncTree> tree() async {
    final j = await _client.get('/api/sync/tree') as Map<String, dynamic>;
    final nodes = (j['nodes'] as List? ?? [])
        .map((n) => ServerBookmark.fromJson(n as Map<String, dynamic>))
        .toList();
    return SyncTree(
      head: ((j['head'] as num?) ?? 0).toInt(),
      othersId: (j['othersId'] as String?) ?? 'md-others',
      nodes: nodes,
    );
  }

  /// POST /api/sync/apply — raw op array (max 16 MiB server-side).
  /// Returns per-op results + new head. Partial wins are normal.
  Future<ApplyResult> apply(List<Map<String, dynamic>> ops) async {
    final j = await _client.post('/api/sync/apply', body: ops) as Map<String, dynamic>;
    final results = (j['results'] as List? ?? [])
        .map((r) => BatchResult.fromJson(r as Map<String, dynamic>))
        .toList();
    return ApplyResult(results: results, head: ((j['head'] as num?) ?? 0).toInt());
  }

  /// GET /api/sync/status -> {head, nodes} — diagnostics.
  Future<({int head, int nodes})> status() async {
    final j = await _client.get('/api/sync/status') as Map<String, dynamic>;
    return (head: ((j['head'] as num?) ?? 0).toInt(), nodes: ((j['nodes'] as num?) ?? 0).toInt());
  }

  /// Connect the revision WebSocket: wss?://host/api/ws?token=...
  /// Server pushes {"t":"rev","rev":N}; client pings every 20s.
  Stream<int> revisions() {
    final base = _client.baseUrl;
    final wsScheme = base.startsWith('https') ? 'wss' : 'ws';
    final httpBase = base.replaceFirst(RegExp('^https?'), wsScheme);
    final token = _client.deviceToken;
    final uri = Uri.parse('$httpBase/api/ws${token != null ? '?token=$token' : ''}');
    final channel = WebSocketChannel.connect(uri);
    final controller = StreamController<int>.broadcast();
    StreamSubscription? sub;
    sub = channel.stream.listen(
      (frame) {
        if (frame is String) {
          try {
            final j = jsonDecode(frame) as Map<String, dynamic>;
            if (j['t'] == 'rev') {
              final rev = ((j['rev'] as num?) ?? 0).toInt();
              if (rev > 0) controller.add(rev);
            }
          } on FormatException {/* ignore stray frames */}
        }
      },
      onError: controller.addError,
      onDone: () {
        controller.close();
        sub?.cancel();
      },
      cancelOnError: false,
    );
    return controller.stream;
  }
}

// ---- wire types (locked by golden contract tests) ----

class SyncTree {
  SyncTree({required this.head, required this.othersId, required this.nodes});
  final int head;
  final String othersId;
  final List<ServerBookmark> nodes;
}

/// store.Bookmark wire shape — field names must match the golden JSON.
class ServerBookmark {
  ServerBookmark({
    required this.id,
    required this.parentId,
    required this.type,
    required this.title,
    this.url,
    this.note = '',
    this.favorite = false,
    this.archived = false,
    this.position = 0,
    this.deletedAt = 0,
    this.purged = false,
    this.revision = 0,
    this.updatedAt = 0,
    this.deviceId,
    this.createdAt = 0,
    this.tags = const [],
  });

  factory ServerBookmark.fromJson(Map<String, dynamic> j) => ServerBookmark(
        id: j['id'] as String,
        parentId: (j['parentId'] as String?) ?? '',
        type: j['type'] as String,
        title: (j['title'] as String?) ?? '',
        url: j['url'] as String?,
        note: (j['note'] as String?) ?? '',
        favorite: (j['favorite'] as bool?) ?? false,
        archived: (j['archived'] as bool?) ?? false,
        position: ((j['position'] as num?) ?? 0).toDouble(),
        deletedAt: ((j['deletedAt'] as num?) ?? 0).toInt(),
        purged: (j['purged'] as bool?) ?? false,
        revision: ((j['revision'] as num?) ?? 0).toInt(),
        updatedAt: ((j['updatedAt'] as num?) ?? 0).toInt(),
        deviceId: j['deviceId'] as String?,
        createdAt: ((j['createdAt'] as num?) ?? 0).toInt(),
        tags: ((j['tags'] as List?) ?? []).map((e) => e.toString()).toList(),
      );

  final String id;
  final String parentId;
  final String type; // 'folder' | 'url'
  final String title;
  final String? url;
  final String note;
  final bool favorite;
  final bool archived;
  final double position;
  final int deletedAt;
  final bool purged;
  final int revision;
  final int updatedAt;
  final String? deviceId;
  final int createdAt;
  final List<String> tags;

  bool get isLive => deletedAt == 0 && !purged;
}

class ApplyResult {
  ApplyResult({required this.results, required this.head});
  final List<BatchResult> results;
  final int head;
}

class BatchResult {
  BatchResult({required this.id, required this.win, this.error, this.state});
  factory BatchResult.fromJson(Map<String, dynamic> j) => BatchResult(
        id: j['id'] as String,
        win: (j['win'] as bool?) ?? false,
        error: j['error'] as String?,
        state: j['state'] == null ? null : ServerBookmark.fromJson(j['state'] as Map<String, dynamic>),
      );
  final String id;
  final bool win;
  final String? error;
  final ServerBookmark? state;
}
