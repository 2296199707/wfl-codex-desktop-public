import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_en.dart';
import 'app_localizations_zh.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'i18n/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations? of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations);
  }

  static const LocalizationsDelegate<AppLocalizations> delegate =
      _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('en'),
    Locale('zh'),
  ];

  /// No description provided for @appTitle.
  ///
  /// In en, this message translates to:
  /// **'WFL Codex Drive'**
  String get appTitle;

  /// No description provided for @homeTitle.
  ///
  /// In en, this message translates to:
  /// **'Sync'**
  String get homeTitle;

  /// No description provided for @accountsTitle.
  ///
  /// In en, this message translates to:
  /// **'Accounts'**
  String get accountsTitle;

  /// No description provided for @settingsTitle.
  ///
  /// In en, this message translates to:
  /// **'Settings'**
  String get settingsTitle;

  /// No description provided for @workflowsTitle.
  ///
  /// In en, this message translates to:
  /// **'Workflows'**
  String get workflowsTitle;

  /// No description provided for @loginTitle.
  ///
  /// In en, this message translates to:
  /// **'Sign in to WFL Codex Drive'**
  String get loginTitle;

  /// No description provided for @loginSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Connect this phone to your server and start syncing files.'**
  String get loginSubtitle;

  /// No description provided for @serverUrlLabel.
  ///
  /// In en, this message translates to:
  /// **'Server address'**
  String get serverUrlLabel;

  /// No description provided for @serverUrlHint.
  ///
  /// In en, this message translates to:
  /// **'https://cloud.example.com'**
  String get serverUrlHint;

  /// No description provided for @serverUrlHelper.
  ///
  /// In en, this message translates to:
  /// **'The app will use the server\'s /dav drive endpoint.'**
  String get serverUrlHelper;

  /// No description provided for @usernameLabel.
  ///
  /// In en, this message translates to:
  /// **'Username'**
  String get usernameLabel;

  /// No description provided for @passwordLabel.
  ///
  /// In en, this message translates to:
  /// **'Password'**
  String get passwordLabel;

  /// No description provided for @loginButton.
  ///
  /// In en, this message translates to:
  /// **'Sign in'**
  String get loginButton;

  /// No description provided for @loggingIn.
  ///
  /// In en, this message translates to:
  /// **'Signing in…'**
  String get loggingIn;

  /// No description provided for @invalidServerUrl.
  ///
  /// In en, this message translates to:
  /// **'Enter a valid http or https server address.'**
  String get invalidServerUrl;

  /// No description provided for @requiredField.
  ///
  /// In en, this message translates to:
  /// **'This field is required.'**
  String get requiredField;

  /// No description provided for @loginFailed.
  ///
  /// In en, this message translates to:
  /// **'Sign-in failed. Check the server address and credentials.'**
  String get loginFailed;

  /// No description provided for @loginSuccess.
  ///
  /// In en, this message translates to:
  /// **'Signed in successfully.'**
  String get loginSuccess;

  /// No description provided for @startupLoading.
  ///
  /// In en, this message translates to:
  /// **'Preparing your drive…'**
  String get startupLoading;

  /// No description provided for @next.
  ///
  /// In en, this message translates to:
  /// **'Next'**
  String get next;

  /// No description provided for @done.
  ///
  /// In en, this message translates to:
  /// **'Done'**
  String get done;

  /// No description provided for @back.
  ///
  /// In en, this message translates to:
  /// **'Back'**
  String get back;

  /// No description provided for @welcomeTitle.
  ///
  /// In en, this message translates to:
  /// **'WFL Codex Drive'**
  String get welcomeTitle;

  /// No description provided for @welcomeBody.
  ///
  /// In en, this message translates to:
  /// **'Welcome. Complete these preparation steps before signing in and syncing files.'**
  String get welcomeBody;

  /// No description provided for @folderPermissionsTitle.
  ///
  /// In en, this message translates to:
  /// **'File permissions'**
  String get folderPermissionsTitle;

  /// No description provided for @folderPermissionsBody.
  ///
  /// In en, this message translates to:
  /// **'The app needs file access to sync folders on your phone.'**
  String get folderPermissionsBody;

  /// No description provided for @grantPermissions.
  ///
  /// In en, this message translates to:
  /// **'Grant permission'**
  String get grantPermissions;

  /// No description provided for @batteryPermissionsTitle.
  ///
  /// In en, this message translates to:
  /// **'Battery permission'**
  String get batteryPermissionsTitle;

  /// No description provided for @batteryPermissionsBody.
  ///
  /// In en, this message translates to:
  /// **'Disable battery optimization so background sync can run.'**
  String get batteryPermissionsBody;

  /// No description provided for @notificationPermissionsTitle.
  ///
  /// In en, this message translates to:
  /// **'Notification permission'**
  String get notificationPermissionsTitle;

  /// No description provided for @notificationPermissionsBody.
  ///
  /// In en, this message translates to:
  /// **'Allow notifications to show sync progress and results.'**
  String get notificationPermissionsBody;

  /// No description provided for @downloadRcloneTitle.
  ///
  /// In en, this message translates to:
  /// **'Prepare sync engine'**
  String get downloadRcloneTitle;

  /// No description provided for @downloadRcloneBody.
  ///
  /// In en, this message translates to:
  /// **'The app uses the open-source RClone sync engine.'**
  String get downloadRcloneBody;

  /// No description provided for @downloadRclone.
  ///
  /// In en, this message translates to:
  /// **'Download RClone'**
  String get downloadRclone;

  /// No description provided for @downloadComplete.
  ///
  /// In en, this message translates to:
  /// **'Complete'**
  String get downloadComplete;

  /// No description provided for @downloadProgress.
  ///
  /// In en, this message translates to:
  /// **'Progress {percent}%'**
  String downloadProgress(Object percent);

  /// No description provided for @accountTooltip.
  ///
  /// In en, this message translates to:
  /// **'Accounts'**
  String get accountTooltip;

  /// No description provided for @settingsTooltip.
  ///
  /// In en, this message translates to:
  /// **'Settings'**
  String get settingsTooltip;

  /// No description provided for @workflowsTooltip.
  ///
  /// In en, this message translates to:
  /// **'Workflows'**
  String get workflowsTooltip;

  /// No description provided for @createConnectionTooltip.
  ///
  /// In en, this message translates to:
  /// **'New sync task'**
  String get createConnectionTooltip;

  /// No description provided for @useRclone.
  ///
  /// In en, this message translates to:
  /// **'Use RClone'**
  String get useRclone;

  /// No description provided for @registerRemoteTitle.
  ///
  /// In en, this message translates to:
  /// **'Add drive account'**
  String get registerRemoteTitle;

  /// No description provided for @remoteNameLabel.
  ///
  /// In en, this message translates to:
  /// **'Account name'**
  String get remoteNameLabel;

  /// No description provided for @wflCodexProvider.
  ///
  /// In en, this message translates to:
  /// **'WFL Codex'**
  String get wflCodexProvider;

  /// No description provided for @webdavUrlLabel.
  ///
  /// In en, this message translates to:
  /// **'Drive URL (https://server/dav)'**
  String get webdavUrlLabel;

  /// No description provided for @wflUsernameLabel.
  ///
  /// In en, this message translates to:
  /// **'WFL Codex username'**
  String get wflUsernameLabel;

  /// No description provided for @submit.
  ///
  /// In en, this message translates to:
  /// **'Save'**
  String get submit;

  /// No description provided for @accountAddFolder.
  ///
  /// In en, this message translates to:
  /// **'Add folder'**
  String get accountAddFolder;

  /// No description provided for @accountInfo.
  ///
  /// In en, this message translates to:
  /// **'Storage info'**
  String get accountInfo;

  /// No description provided for @accountDelete.
  ///
  /// In en, this message translates to:
  /// **'Delete account'**
  String get accountDelete;

  /// No description provided for @localTitle.
  ///
  /// In en, this message translates to:
  /// **'Phone storage'**
  String get localTitle;

  /// No description provided for @remoteAvailable.
  ///
  /// In en, this message translates to:
  /// **'Connected'**
  String get remoteAvailable;

  /// No description provided for @remoteUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Connection failed'**
  String get remoteUnavailable;

  /// No description provided for @remoteChecking.
  ///
  /// In en, this message translates to:
  /// **'Checking'**
  String get remoteChecking;

  /// No description provided for @folderRegisterTitle.
  ///
  /// In en, this message translates to:
  /// **'Add folder'**
  String get folderRegisterTitle;

  /// No description provided for @folderTitleLabel.
  ///
  /// In en, this message translates to:
  /// **'Folder name'**
  String get folderTitleLabel;

  /// No description provided for @selectLocalFolder.
  ///
  /// In en, this message translates to:
  /// **'Select phone folder'**
  String get selectLocalFolder;

  /// No description provided for @selectFolder.
  ///
  /// In en, this message translates to:
  /// **'Select folder'**
  String get selectFolder;

  /// No description provided for @remoteParentPathLabel.
  ///
  /// In en, this message translates to:
  /// **'Remote parent folder'**
  String get remoteParentPathLabel;

  /// No description provided for @remoteParentPathHelper.
  ///
  /// In en, this message translates to:
  /// **'Choose a project folder first. Files stay inside your account\'s project.'**
  String get remoteParentPathHelper;

  /// No description provided for @connectionTitle.
  ///
  /// In en, this message translates to:
  /// **'New sync task'**
  String get connectionTitle;

  /// No description provided for @connectionTitleHint.
  ///
  /// In en, this message translates to:
  /// **'Task name'**
  String get connectionTitleHint;

  /// No description provided for @firstFolder.
  ///
  /// In en, this message translates to:
  /// **'Select source folder'**
  String get firstFolder;

  /// No description provided for @secondFolder.
  ///
  /// In en, this message translates to:
  /// **'Select destination folder'**
  String get secondFolder;

  /// No description provided for @upload.
  ///
  /// In en, this message translates to:
  /// **'Upload'**
  String get upload;

  /// No description provided for @download.
  ///
  /// In en, this message translates to:
  /// **'Download'**
  String get download;

  /// No description provided for @bidirectional.
  ///
  /// In en, this message translates to:
  /// **'Two-way sync'**
  String get bidirectional;

  /// No description provided for @connectionCreated.
  ///
  /// In en, this message translates to:
  /// **'Sync task created'**
  String get connectionCreated;

  /// No description provided for @missingConnectionFields.
  ///
  /// In en, this message translates to:
  /// **'Enter a task name and select two folders.'**
  String get missingConnectionFields;

  /// No description provided for @sync.
  ///
  /// In en, this message translates to:
  /// **'Sync'**
  String get sync;

  /// No description provided for @edit.
  ///
  /// In en, this message translates to:
  /// **'Edit'**
  String get edit;

  /// No description provided for @delete.
  ///
  /// In en, this message translates to:
  /// **'Delete'**
  String get delete;

  /// No description provided for @cancel.
  ///
  /// In en, this message translates to:
  /// **'Cancel'**
  String get cancel;

  /// No description provided for @autoSync.
  ///
  /// In en, this message translates to:
  /// **'Auto sync'**
  String get autoSync;

  /// No description provided for @deleteOnSync.
  ///
  /// In en, this message translates to:
  /// **'Delete on sync'**
  String get deleteOnSync;

  /// No description provided for @offlineBanner.
  ///
  /// In en, this message translates to:
  /// **'Limited network connectivity'**
  String get offlineBanner;

  /// No description provided for @needTwoFolders.
  ///
  /// In en, this message translates to:
  /// **'Create at least one phone folder and one drive folder first.'**
  String get needTwoFolders;

  /// No description provided for @syncFailed.
  ///
  /// In en, this message translates to:
  /// **'Sync failed'**
  String get syncFailed;

  /// No description provided for @connectionNotReady.
  ///
  /// In en, this message translates to:
  /// **'The sync task is not ready'**
  String get connectionNotReady;

  /// No description provided for @showPassword.
  ///
  /// In en, this message translates to:
  /// **'Show password'**
  String get showPassword;

  /// No description provided for @hidePassword.
  ///
  /// In en, this message translates to:
  /// **'Hide password'**
  String get hidePassword;

  /// No description provided for @github.
  ///
  /// In en, this message translates to:
  /// **'RClone GitHub'**
  String get github;

  /// No description provided for @invalidFields.
  ///
  /// In en, this message translates to:
  /// **'Please check and complete all fields.'**
  String get invalidFields;
}

class _AppLocalizationsDelegate
    extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['en', 'zh'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'en':
      return AppLocalizationsEn();
    case 'zh':
      return AppLocalizationsZh();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
