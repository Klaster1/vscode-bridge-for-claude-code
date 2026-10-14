# Forecast API

The forecast service returns hourly temperatures for one city.

## Requests

Send a `GET` request to `/forecast` with the city name in the `city` query parameter.
The response lists the next 24 hours, starting at the current hour.

## Caching

Responses stay in the cache for ten minutes.
A second request for the same city in that time returns the cached forecast.

## Errors

An unknown city returns status 404 with a short message.
