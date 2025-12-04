import importlib.util
import os

here = os.path.dirname(__file__)
app_path = os.path.join(here, "app.py")
spec = importlib.util.spec_from_file_location("app", app_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
resp = mod.app.test_client().get("/health")
print(resp.data.decode())
