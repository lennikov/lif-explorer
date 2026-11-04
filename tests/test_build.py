import sys
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'scripts'))
from build import build

class TestBuild(unittest.TestCase):
    def test_byte_identical_recovered_release(self):
        self.assertEqual(build().encode('utf-8'),(ROOT/'LIF_Studio.html').read_bytes())
    def test_browser_local_distribution(self):
        page=build()
        self.assertNotIn('<script src="http',page)
        self.assertIn('window.LifStudio',page)
if __name__=='__main__':
    unittest.main()
