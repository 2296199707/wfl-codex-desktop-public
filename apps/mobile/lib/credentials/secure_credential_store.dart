import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'memory_credential_store.dart';

class SecureCredentialStore implements CredentialStore {
  SecureCredentialStore() : _storage = const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

CredentialStore createCredentialStore() => SecureCredentialStore();
