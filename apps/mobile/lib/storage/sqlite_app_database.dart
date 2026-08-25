import 'package:path/path.dart' as path;
import 'package:sqflite/sqflite.dart';

import 'memory_app_database.dart';

class SqliteAppDatabase implements AppDatabase {
  SqliteAppDatabase(this._database);

  final Database _database;

  static Future<SqliteAppDatabase> open() async {
    final database = await openDatabase(
      path.join(await getDatabasesPath(), 'wfl_mobile_app.db'),
      version: 1,
      onCreate: (db, _) => db.execute(
        'CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL)',
      ),
    );
    return SqliteAppDatabase(database);
  }

  @override
  Future<List<AppServer>> listServers() async {
    final rows = await _database.query('servers', orderBy: 'name');
    return rows
        .map((row) => AppServer(
              id: row['id']! as String,
              name: row['name']! as String,
              host: row['host']! as String,
            ))
        .toList();
  }

  @override
  Future<void> saveServer(AppServer server) async {
    await _database.insert(
      'servers',
      {'id': server.id, 'name': server.name, 'host': server.host},
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  @override
  Future<void> deleteServer(String id) async {
    await _database.delete('servers', where: 'id = ?', whereArgs: [id]);
  }

  @override
  Future<void> close() => _database.close();
}

Future<AppDatabase> createAppDatabase() => SqliteAppDatabase.open();
