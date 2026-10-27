# Florida 3PL (Greentek Orders): the app uses only Python's standard library, so the image needs no installs.
FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app
COPY *.py ./
COPY web ./web

# Everything the app stores (orders, returns, logins, uploads, settings) lives in /app/data. Mount a volume there.
RUN useradd --create-home --uid 1000 app && mkdir -p /app/data && chown -R app:app /app
COPY --chmod=755 entrypoint.sh /app/entrypoint.sh
VOLUME /app/data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD python -c "import urllib.request,os; urllib.request.urlopen('http://127.0.0.1:%s/api/build' % os.environ.get('PORT','8080'), timeout=4)"

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["python", "server.py"]
