import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:fpdart/fpdart.dart';
import 'package:hashlib/random.dart';
import 'package:injectable/injectable.dart';
import 'package:path/path.dart';
import 'package:syncvault/errors.dart';
import 'package:syncvault/log.dart';
import 'package:syncvault/src/accounts/models/file_model.dart';
import 'package:syncvault/src/accounts/models/folder_model.dart';
import 'package:syncvault/src/home/models/connection_model.dart';
import 'package:syncvault/src/common/services/rclone.dart';
import 'package:syncvault/src/home/models/drive_provider.dart';
import 'package:syncvault/src/home/models/drive_provider_model.dart';
import 'package:syncvault/src/home/models/progress_model.dart';
import 'package:syncvault/src/home/services/common.dart';

String _normalizeRemoteRelativePath(String value, {bool allowEmpty = true}) {
  final segments = value
      .trim()
      .replaceAll('\\', '/')
      .split('/')
      .where((segment) => segment.trim().isNotEmpty)
      .map((segment) => segment.trim())
      .toList();
  if (!allowEmpty && segments.isEmpty) {
    throw const FormatException('Remote path cannot be empty');
  }
  if (segments.any(
    (segment) =>
        segment == '.' ||
        segment == '..' ||
        segment.contains(':') ||
        RegExp(r'[\u0000-\u001f\u007f]').hasMatch(segment),
  )) {
    throw const FormatException('Remote path is invalid');
  }
  return segments.join('/');
}

String _remoteFolderPath(
  String remoteName,
  String folderName,
  String? parentPath,
) {
  final parent = _normalizeRemoteRelativePath(parentPath ?? '');
  final folder = _normalizeRemoteRelativePath(folderName, allowEmpty: false);
  return '$remoteName:/${[if (parent.isNotEmpty) parent, folder].join('/')}';
}

String _remoteListPath(String remoteName, String path) {
  final relative = _normalizeRemoteRelativePath(path);
  return '$remoteName:/${relative.isEmpty ? '' : relative}';
}

@singleton
class RCloneDriveService implements DriveService {
  @override
  TaskEither<AppError, FolderModel> create({
    required String folderName,
    required DriveProviderModel model,
    required Option<String> parentPath,
  }) {
    final utils = RCloneUtils();

    return TaskEither<AppError, RemoteFolderModel>.Do(($) async {
      final execPath = await $(utils.getRCloneExec());
      final configArgs = await $(utils.getConfigArgs());

      final remoteName = await $(
        TaskEither.tryCatch(() async {
          final process = await Process.run(execPath, [
            ...configArgs,
            'mkdir',
            _remoteFolderPath(
              (model as RemoteProviderModel).remoteName,
              folderName,
              parentPath.toNullable(),
            ),
          ]);

          if (process.stderr.toString().trim().isNotEmpty) {
            logger.e(process.stderr);
          }
          if (process.exitCode != 0) {
            throw GeneralError(
              'Failed to create remote folder',
              process.stderr.toString().trim(),
              null,
            );
          }

          return model.remoteName;
        }, (err, stackTrace) => GeneralError('', err, stackTrace).logError()),
      );

      final folderModel = RemoteFolderModel(
        id: uuid.v4(),
        folderName: folderName,
        remoteName: remoteName,
        parentPath: parentPath.toNullable(),
        folderId: null,
        createdAt: DateTime.now(),
        updatedAt: DateTime.now(),
      );
      return folderModel;
    });
  }

  @override
  TaskEither<AppError, ()> delete({
    required DriveProviderModel providerModel,
    required FolderModel folderModel,
  }) {
    final utils = RCloneUtils();

    return TaskEither<AppError, ()>.Do(($) async {
      final execPath = await $(utils.getRCloneExec());
      final configArgs = await $(utils.getConfigArgs());

      final res = await $(
        TaskEither.tryCatch(() async {
          final process = await Process.run(execPath, [
            ...configArgs,
            'purge',
            _remoteFolderPath(
              (folderModel as RemoteFolderModel).remoteName,
              folderModel.folderName,
              folderModel.parentPath,
            ),
          ]);

          if (process.stderr.toString().trim().isNotEmpty) {
            logger.e(process.stderr.toString());
          }
          if (process.exitCode != 0) {
            throw GeneralError(
              'Failed to delete remote folder',
              process.stderr.toString().trim(),
              null,
            );
          }

          return ();
        }, (err, stackTrace) => GeneralError('', err, stackTrace).logError()),
      );

      return res;
    });
  }

  @override
  TaskEither<AppError, Option<FileModel>> treeView({
    required DriveProviderModel providerModel,
    required Option<FolderModel> folderModel,
  }) {
    final utils = RCloneUtils();

    return TaskEither<AppError, Option<FileModel>>.Do(($) async {
      final execPath = await $(utils.getRCloneExec());
      final configArgs = await $(utils.getConfigArgs());

      final Option<FileModel> fileModel = await $(
        TaskEither.tryCatch(
          () async {
            final remoteName = switch (providerModel) {
              RemoteProviderModel(:final remoteName) => remoteName,
              _ => throw GeneralError(
                'Only remote folders allowed',
                null,
                null,
              ),
            };

            final isOneDrive = providerModel.provider is OneDriveProvider;

            final remotePath = switch (folderModel) {
              Some(
                value: RemoteFolderModel(:final folderName, :final parentPath),
              ) =>
                _remoteFolderPath(remoteName, folderName, parentPath),
              // No model passed implies root of remote
              None() => '$remoteName:',
              _ => throw GeneralError(
                'Only remote folders allowed',
                null,
                null,
              ),
            };

            final process = await Process.run(execPath, [
              ...configArgs,
              'tree',
              '-a',
              '--dirsfirst',
              '--full-path',
              '-s',
              '-Q',
              remotePath,
              // Personal Vault folder is restricted in OneDrive
              if (isOneDrive) ...['--exclude', '"Personal Vault/**"'],
            ]);

            if (process.stderr.toString().trim().isNotEmpty) {
              logger.e(process.stderr.toString());
            }

            final List<List<String>> matches = [];
            final output = process.stdout.toString();
            final lines = output.split('\n');

            // String is of the pattern - <garbage value> [     123]  "<path>"
            final regex = RegExp(
              r'\[\s*(\d+)\s*\]\s*\"([^\"]+)\"',
              dotAll: true,
            );
            for (final line in lines) {
              final matched = regex
                  .allMatches(line)
                  .toList()
                  .map((t) => t.groups([1, 2]))
                  .firstOrNull;
              if (matched != [] && matched != null) {
                matches.add([matched[0]!, matched[1]!.replaceAll('\\', '/')]);
              }
            }

            final done = [];
            FileModel buildFileTree(
              List<List<String>> paths,
              String currentPath,
              String currentSize,
              Option<Directory> parent,
            ) {
              // Get the name of the current path
              final currentSegments = currentPath
                  .split('/')
                  .where((seg) => seg.isNotEmpty)
                  .toList();
              final currentName = currentSegments.isEmpty
                  ? '/'
                  : currentSegments.last;

              // Find direct children of the current path
              final childrenPaths = paths.where((path) {
                final segments = path[1]
                    .split('/')
                    .where((seg) => seg.isNotEmpty)
                    .toList();
                return segments.length > currentSegments.length &&
                    List.generate(
                          currentSegments.length,
                          (i) => segments[i],
                        ).join('/') ==
                        currentSegments.join('/');
              }).toList();

              // Create child nodes recursively
              final List<FileModel> children = [];
              for (final childPath in childrenPaths) {
                final segments = childPath[1]
                    .split('/')
                    .where((seg) => seg.isNotEmpty)
                    .toList();
                final size = childPath[0];
                final childFullPath = segments.join('/');

                if (!done.contains(childFullPath)) {
                  done.add(childFullPath);
                  children.add(
                    buildFileTree(
                      paths,
                      childFullPath,
                      size,
                      some(Directory(currentPath)),
                    ),
                  );
                }
              }

              // Determine if the current node is a file or directory
              final isFile = !paths.any((path) {
                final segments = path[1]
                    .split('/')
                    .where((seg) => seg.isNotEmpty)
                    .toList();
                return segments.length > currentSegments.length &&
                    List.generate(
                          currentSegments.length,
                          (i) => segments[i],
                        ).join('/') ==
                        currentSegments.join('/');
              });

              final fileEntity = isFile
                  ? File(currentPath)
                  : Directory(currentPath);

              return FileModel(
                name: currentName,
                size: currentSize,
                file: fileEntity,
                parent: parent.toNullable() ?? Directory(''),
                isDirectory: false, // FIXME:
                children: children,
              );
            }

            if (matches.isNotEmpty) {
              final model = buildFileTree(matches, '/', '0', none());
              return some(model);
            }

            return none();
          },
          (err, stackTrace) {
            return AppError.general('message', err, stackTrace).logError();
          },
        ),
      );
      return fileModel;
    });
  }

  @override
  TaskEither<AppError, List<FileModel>> listView({
    required DriveProviderModel providerModel,
    required String path,
  }) {
    final utils = RCloneUtils();

    return TaskEither<AppError, List<FileModel>>.Do(($) async {
      final execPath = await $(utils.getRCloneExec());
      final configArgs = await $(utils.getConfigArgs());

      final List<FileModel> fileModel = await $(
        TaskEither.tryCatch(
          () async {
            final remoteName = switch (providerModel) {
              RemoteProviderModel(:final remoteName) => remoteName,
              _ => throw GeneralError(
                'Only remote folders allowed',
                null,
                null,
              ),
            };

            final isOneDrive = providerModel.provider is OneDriveProvider;

            final process = await Process.run(execPath, [
              ...configArgs,
              'lsf',
              '--format',
              'psm',
              _remoteListPath(remoteName, path),
              // Personal Vault folder is restricted in OneDrive
              if (isOneDrive) ...['--exclude', '"Personal Vault/**"'],
            ]);

            if (process.stderr.toString().trim().isNotEmpty) {
              logger.e(process.stderr.toString());
            }

            final output = process.stdout.toString();
            final lines = output.split('\n');
            final files = lines
                .filter((x) => x.isNotEmpty)
                .map((x) => x.split(';'))
                .map(
                  (l) => FileModel(
                    name: Uri.file(
                      l[0],
                    ).pathSegments.lastWhere((x) => x.isNotEmpty),
                    size: l[1],
                    file: File(join(path.isEmpty ? '/' : path, l[0])),
                    parent: Directory(path.isEmpty ? '/' : path),
                    isDirectory: l[2].contains('dir'),
                    children: [],
                  ),
                )
                .toList();

            return files;
          },
          (err, stackTrace) {
            return AppError.general('message', err, stackTrace).logError();
          },
        ),
      );

      return fileModel;
    });
  }
}

@singleton
class RCloneSyncService implements SyncService {
  Option<String> rClonePath = const None();

  void setRClonePath(String path) {
    rClonePath = Some(path);
  }

  Option<ProgressModel> parseProgress(String input) {
    return Either.tryCatch(() {
      final [sizes, percentage, speed, eta] = input.split(',');

      final progress = ProgressModel(
        percentage: int.parse(percentage.replaceAll('%', '')),
        // eta: eta.allMatches('ETA\\s(\\d+)\\w').first.group(group),
        eta: Duration(seconds: 0),
        speed: 1,
        completedSize: 1,
        totalSize: 1,
      );
      return progress;
    }, (err, st) => GeneralError('message', err, st).logError()).toOption();
  }

  @override
  Stream<Either<AppError, Option<ProgressModel>>> sync_({
    required ConnectionModel connectionModel,
    required FolderModel firstFolder,
    required DriveProviderModel firstProvider,
    required FolderModel secondFolder,
    required DriveProviderModel secondProvider,
  }) async* {
    final progressStreamController =
        StreamController<Either<AppError, Option<ProgressModel>>>();
    final utils = RCloneUtils();

    try {
      final calledExecPath = utils.getRCloneExec();
      final execPath = await calledExecPath
          .orElse<AppError>(
            (err) => TaskEither<AppError, String>.fromOption(
              rClonePath,
              () => GeneralError(
                'RClone path not supplied by background task',
                err,
                err.stackTrace,
              ).logError(),
            ),
          )
          .run();
      if (execPath.isLeft()) {
        yield Left(execPath.getLeft().toNullable()!);
      }

      final configArgs = await utils.getConfigArgs().run();
      if (configArgs.isLeft()) {
        yield Left(configArgs.getLeft().toNullable()!);
      }

      final firstPath = switch (firstFolder) {
        LocalFolderModel(:final folderPath) => folderPath,
        RemoteFolderModel(
          :final remoteName,
          :final folderName,
          :final parentPath,
        ) =>
          _remoteFolderPath(remoteName, folderName, parentPath),
      };
      final secondPath = switch (secondFolder) {
        LocalFolderModel(:final folderPath) => folderPath,
        RemoteFolderModel(
          :final remoteName,
          :final folderName,
          :final parentPath,
        ) =>
          _remoteFolderPath(remoteName, folderName, parentPath),
      };

      final process = await Process.start(execPath.toNullable()!, [
        // Use a 2 way copy to avoid deletion
        ...(configArgs.toNullable()!),
        connectionModel.direction == SyncDirection.bidirectional
            ? 'bisync'
            : 'sync',
        '-u', // Do not delete/update on remote if remote file is newer
        '-M',
        '--progress',
        '--stats-one-line',
        '--inplace', // Bisync fails without this
        if (connectionModel.direction == SyncDirection.bidirectional)
          '--resync',
        firstPath,
        secondPath,
      ]);

      process.stderr.transform(utf8.decoder).listen((data) {
        progressStreamController.add(Right(parseProgress(data)));
      });

      process.stdout
          .transform(utf8.decoder)
          .listen(
            (str) => progressStreamController.add(Right(parseProgress(str))),
          );

      yield* progressStreamController.stream;
    } catch (err) {
      progressStreamController.add(Left(GeneralError('', null, null)));
    } finally {
      progressStreamController.close();
    }
  }
}
