// Copyright (C) 2025 Piers Finlayson <piers@piers.rocks>
//
// MIT License

fetch('/footer.html')
    .then(response => response.text())
    .then(data => document.getElementById('footer').innerHTML = data);
