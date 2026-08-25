import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:logger/logger.dart';
import 'package:path_provider/path_provider.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import 'package:sentry_flutter/sentry_flutter.dart';
import 'package:syncvault/src/settings/controllers/settings_controller.dart';

final container = ProviderContainer();

final logger = Logger(
  output: MultiOutput([
    FileLogOutput(),
    if (kDebugMode) DebugLogOutput(),
    SentryLogOutput(container),
  ]),
  printer: CustomPrinter(),
  filter: CustomLogFilter(),
);

final class CustomPrinter extends LogPrinter {
  @override
  List<String> log(LogEvent event) {
    final timeStr = event.time.toIso8601String();
    final levelStr = event.level.name.toUpperCase().padRight(5);
    final message = event.message;
    final error = event.error;
    final stackTrace = event.stackTrace;

    final List<String> lines = ['$timeStr [$levelStr] $message'];

    if (error != null) {
      lines.add('└─ Error: $error');
    }

    if (stackTrace != null) {
      final stackLines = stackTrace.toString().split('\n');
      if (stackLines.isNotEmpty) {
        lines.add('└─ StackTrace:');
        for (final line in stackLines) {
          if (line.trim().isNotEmpty) {
            lines.add('   $line');
          }
        }
      }
    }

    return lines;
  }
}

final class CustomLogFilter extends LogFilter {
  @override
  bool shouldLog(LogEvent event) {
    return event.level != Level.debug;
  }
}

final class DebugLogOutput extends LogOutput {
  @override
  void output(OutputEvent event) async {
    for (final line in event.lines) {
      debugPrint(line);
    }
  }
}

final class FileLogOutput extends LogOutput {
  @override
  void output(OutputEvent event) async {
    final now = DateTime.now();
    final dateString =
        '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';

    final docDir = await getApplicationDocumentsDirectory();
    final dir = Directory('${docDir.path}/SyncVault/logs/');

    if (!await dir.exists()) {
      await dir.create(recursive: true);
    }

    final file = File('${dir.path}/syncvault_$dateString.log');

    final sink = file.openWrite(mode: FileMode.append);
    for (final line in event.lines) {
      sink.writeln(line);
    }
    await sink.close();
  }
}

final class SentryLogOutput extends LogOutput {
  SentryLogOutput(this.container);

  final ProviderContainer container;

  @override
  void output(OutputEvent event) async {
    final settingsValue = container.read(settingsProvider);

    final isSentryEnabled = switch (settingsValue) {
      AsyncData(:final value) => value.isSentryEnabled,
      _ => false,
    };

    if (isSentryEnabled) {
      await Sentry.captureException(
        event.origin.error,
        stackTrace: event.origin.stackTrace,
      );
    }
  }
}
