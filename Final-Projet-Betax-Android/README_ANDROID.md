# Final Projet Betax - Android Studio

Application Android native légère qui embarque la version Web de Final Projet Betax dans une `WebView` sécurisée.

## Ouvrir et compiler

1. Ouvrir le dossier `Final-Projet-Betax-Android` dans Android Studio.
2. Laisser Android Studio synchroniser les dépendances Gradle.
3. Lancer sur un appareil ou émulateur Android (API 24+).
4. Pour générer un APK debug : menu **Build > Build APK(s)**.

## Ce que fait le conteneur Android

- Charge les pages locales via `WebViewAssetLoader`.
- Demande la permission de localisation uniquement lorsque l'utilisateur active la position.
- Applique le thème clair/sombre choisi dans Betax aux barres système Android.
- Ouvre les liens e-mail et Web externes avec les applications du téléphone.

## Limites

Le fond de carte Leaflet et la recherche cartographique nécessitent Internet. Les lignes, arrêts, favoris et planificateur local continuent de fonctionner avec les ressources embarquées.

Aucun APK n'est joint à ce projet : la compilation nécessite Android Studio, le SDK Android et Gradle sur la machine de développement.
