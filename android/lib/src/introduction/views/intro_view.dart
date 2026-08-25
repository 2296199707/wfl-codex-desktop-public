import 'dart:io';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:introduction_screen/introduction_screen.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:syncvault/src/introduction/controllers/intro_controller.dart';
import 'package:url_launcher/url_launcher_string.dart';
import 'package:syncvault/extensions.dart';
import 'package:syncvault/errors.dart';
import 'package:syncvault/src/localization/generated/i18n/app_localizations.dart';

class IntroductionView extends StatefulHookConsumerWidget {
  const IntroductionView({super.key});

  static const routeName = '/introduction';

  @override
  ConsumerState<IntroductionView> createState() => _IntroductionViewState();
}

class _IntroductionViewState extends ConsumerState<IntroductionView> {
  final _introKey = GlobalKey<IntroductionScreenState>();

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final rCloneDownloadProgress = ref.watch(rCloneDownloadControllerProvider);
    final rCloneDownloadControllerNotifier = ref.read(
      rCloneDownloadControllerProvider.notifier,
    );
    final introSettingsNotifier = ref.read(introSettingsProvider.notifier);

    ref.listen<AsyncValue>(rCloneDownloadControllerProvider, (prev, state) {
      if (!state.isLoading && state.hasError) {
        context.showErrorSnackBar(
          GeneralError(
            'RClone download controller failed',
            state.error!,
            state.stackTrace,
          ).logError().message,
        );
      }
    });

    return Scaffold(
      body: IntroductionScreen(
        key: _introKey,
        next: Text(l10n.next),
        done: Text(
          l10n.done,
          style: const TextStyle(fontWeight: FontWeight.w700),
        ),
        back: Text(l10n.back),
        showBackButton: true,
        dotsDecorator: DotsDecorator(
          activeColor: Theme.of(context).colorScheme.primary,
        ),
        onDone: () {
          introSettingsNotifier.setAlreadyViewed(); // TODO: Handle error
          Navigator.of(context).pushReplacementNamed('/');
        },
        pages: [
          PageViewModel(
            title: l10n.welcomeTitle,
            body: l10n.welcomeBody,
            image: const Center(child: Icon(Icons.waving_hand, size: 50.0)),
          ),
          if (Platform.isAndroid)
            PageViewModel(
              title: l10n.folderPermissionsTitle,
              body: l10n.folderPermissionsBody,
              image: const Center(child: Icon(Icons.folder, size: 50.0)),
              footer: Center(
                child: FilledButton(
                  onPressed: () async {
                    await Permission.manageExternalStorage
                        .onDeniedCallback(() {})
                        .onGrantedCallback(() {
                          _introKey.currentState?.next();
                        })
                        .request();
                  },
                  child: Text(l10n.grantPermissions),
                ),
              ),
            ),
          if (Platform.isAndroid)
            PageViewModel(
              title: l10n.batteryPermissionsTitle,
              body: l10n.batteryPermissionsBody,
              image: const Center(child: Icon(Icons.battery_saver, size: 50.0)),
              footer: Center(
                child: FilledButton(
                  onPressed: () async {
                    await Permission.ignoreBatteryOptimizations
                        .onDeniedCallback(() {})
                        .onGrantedCallback(() {
                          _introKey.currentState?.next();
                        })
                        .request();
                  },
                  child: Text(l10n.grantPermissions),
                ),
              ),
            ),
          if (Platform.isAndroid)
            PageViewModel(
              title: l10n.notificationPermissionsTitle,
              body: l10n.notificationPermissionsBody,
              image: const Center(child: Icon(Icons.notifications, size: 50.0)),
              footer: Center(
                child: FilledButton(
                  onPressed: () async {
                    await Permission.notification
                        .onDeniedCallback(() {})
                        .onGrantedCallback(() {
                          introSettingsNotifier
                              .setAlreadyViewed(); // TODO: Handle error
                          Navigator.of(context).pushReplacementNamed('/');
                        })
                        .request();
                  },
                  child: Text(l10n.grantPermissions),
                ),
              ),
            ),
          if (!Platform.isAndroid)
            PageViewModel(
              title: l10n.downloadRcloneTitle,
              bodyWidget: Column(
                children: [
                  Text(l10n.downloadRcloneBody, textAlign: TextAlign.center),
                  TextButton(
                    onPressed: () async {
                      final res = await launchUrlString(
                        'https://github.com/rclone/rclone',
                      );
                      if (!res && context.mounted) {
                        context.showErrorSnackBar('Failed to open URL');
                      }
                    },
                    child: Text('RClone GitHub'),
                  ),
                ],
              ),
              image: const Center(child: Icon(Icons.download, size: 50.0)),
              footer: Center(
                child: FilledButton(
                  onPressed:
                      (rCloneDownloadProgress.isLoading ||
                          (rCloneDownloadProgress.value != null &&
                              rCloneDownloadProgress.value != 0))
                      ? null
                      : () async {
                          await rCloneDownloadControllerNotifier
                              .rCloneDownload();
                        },
                  child: Text(
                    rCloneDownloadProgress.isLoading ||
                            rCloneDownloadProgress.value != null &&
                                rCloneDownloadProgress.value != 0
                        ? rCloneDownloadProgress.value == 100
                              ? l10n.downloadComplete
                              : l10n.downloadProgress(
                                  rCloneDownloadProgress.value ?? 0,
                                )
                        : l10n.downloadRclone,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
