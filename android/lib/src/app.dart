import 'dart:async';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:syncvault/extensions.dart';
import 'package:syncvault/src/auth/login_view.dart';
import 'package:syncvault/src/accounts/controllers/auth_controller.dart';
import 'package:syncvault/src/accounts/controllers/status_controller.dart';
import 'package:syncvault/src/home/models/drive_provider.dart';
import 'package:syncvault/src/home/models/drive_provider_model.dart';
import 'package:syncvault/src/accounts/views/account_view.dart';
import 'package:syncvault/src/workflows/views/workflow_view.dart';
import 'package:syncvault/src/introduction/controllers/intro_controller.dart';
import 'package:syncvault/src/introduction/views/intro_view.dart';
import 'package:syncvault/src/localization/generated/i18n/app_localizations.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

import 'home/views/home_view.dart';
import 'settings/controllers/settings_controller.dart';
import 'settings/views/settings_view.dart';

class MyApp extends StatefulHookConsumerWidget {
  const MyApp({super.key});

  @override
  ConsumerState<MyApp> createState() => _MyAppState();
}

class _MyAppState extends ConsumerState<MyApp>
    with WindowListener, TrayListener {
  late final StreamSubscription<List<ConnectivityResult>> subscription;
  var isConnected = true;

  @override
  void initState() {
    super.initState();

    subscription = Connectivity().onConnectivityChanged.listen((
      List<ConnectivityResult> result,
    ) {
      setState(() {
        isConnected = !result.contains(ConnectivityResult.none);
      });
    });

    if (PlatformExtension.isDesktop) {
      String iconPath = Platform.isWindows
          ? 'assets/icons/tray_icon.ico'
          : 'assets/icons/tray_icon.png';

      trayManager.addListener(this);

      final menu = Menu(
        items: [
          MenuItem(
            label: 'Show',
            onClick: (menuItem) async => await windowManager.show(),
          ),
          MenuItem(
            label: 'Hide',
            onClick: (menuItem) async => await windowManager.hide(),
          ),
          MenuItem(
            label: 'Exit',
            onClick: (menuItem) async => await windowManager.close(),
          ),
        ],
      );
      trayManager.setTitle('WFL Codex Sync');
      trayManager.setContextMenu(menu);
      trayManager.setIcon(iconPath);
    }
  }

  @override
  void dispose() {
    subscription.cancel();
    trayManager.removeListener(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(settingsProvider);

    return MaterialApp(
      restorationScopeId: 'app',
      debugShowCheckedModeBanner: false,
      home: const EntryView(),
      locale: const Locale('zh'),
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: AppLocalizations.supportedLocales,
      onGenerateTitle: (BuildContext context) =>
          AppLocalizations.of(context)!.appTitle,
      theme: lightTheme,
      darkTheme: darkTheme,
      themeMode: settings.value?.themeMode,
      builder: (context, child) {
        return Column(
          children: [
            Visibility(
              visible: !isConnected,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(
                  vertical: 8,
                  horizontal: 16,
                ),
                color: Colors.orange,
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const Icon(
                      Icons.signal_wifi_off,
                      size: 16,
                      color: Colors.white,
                    ),
                    const SizedBox(width: 8),
                    Text(
                      AppLocalizations.of(context)!.offlineBanner,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Colors.white,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            Expanded(child: child!),
          ],
        );
      },
      onGenerateRoute: (RouteSettings routeSettings) {
        return MaterialPageRoute<void>(
          settings: routeSettings,
          builder: (BuildContext context) {
            return switch (routeSettings.name) {
              SettingsView.routeName => const SettingsView(),
              // Always pass through the entry gate.  A stale WebDAV account
              // must not make a user appear signed in just because its local
              // rclone configuration still exists.
              HomeView.routeName => const EntryView(),
              LoginView.routeName => const LoginView(),
              AccountView.routeName => const AccountView(),
              WorkflowsView.routeName => const WorkflowsView(),
              IntroductionView.routeName => const IntroductionView(),
              _ => const EntryView(),
            };
          },
        );
      },
    );
  }

  @override
  void onTrayIconMouseDown() async {
    await windowManager.show();
  }
}

class EntryView extends ConsumerWidget {
  const EntryView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final introSettings = ref.watch(introSettingsProvider);
    final accounts = ref.watch(authProvider);
    if (!introSettings.alreadyViewed) return const IntroductionView();
    if (accounts.isLoading && accounts.value == null) {
      return Scaffold(
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const CircularProgressIndicator(),
              const SizedBox(height: 16),
              Text(AppLocalizations.of(context)!.startupLoading),
            ],
          ),
        ),
      );
    }
    RemoteProviderModel? wflAccount;
    for (final account in accounts.value ?? const <DriveProviderModel>[]) {
      if (account is RemoteProviderModel &&
          account.provider is NextCloudProvider) {
        wflAccount = account;
        break;
      }
    }

    if (wflAccount == null) return const LoginView();

    final connection = ref.watch(connectionStatusProvider(wflAccount));
    return connection.when(
      data: (isHealthy) => isHealthy ? const HomeView() : const LoginView(),
      error: (_, _) => const LoginView(),
      loading: () => Scaffold(
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const CircularProgressIndicator(),
              const SizedBox(height: 16),
              Text(AppLocalizations.of(context)!.startupLoading),
            ],
          ),
        ),
      ),
    );
  }
}
