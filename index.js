const express = require("express");
const cors = require("cors");
const app = express();
const port = process.env.PORT || 4000;

// middleware
app.use(cors());
app.use(express.json()); //for converting stringify to object

app.get("/", (req, res) => {
  res.send("prize arena server is running");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

// npm install cors
