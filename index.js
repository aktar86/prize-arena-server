const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const port = process.env.PORT || 4000;

const serviceAccount = require("./prize-arena-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middleware
app.use(cors());
app.use(express.json()); //for converting stringify to object

//verify fire base token
const verifyFireBaseToken = async (req, res, next) => {
  console.log("Headers aktar: ", req.headers);

  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log(decoded);
  } catch {
    return res.status(401).send({ message: "unauthorized access" });
  }
  next();
};

const uri = process.env.PA_MONGO_URI;

// Create a MongoClient
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const run = async () => {
  try {
    await client.connect();

    const db = client.db("prize_arena_DB");
    const usersCollection = db.collection("users");
    const creatorsCollection = db.collection("creators");

    //users related api
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createAt = new Date();

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    //creator related api
    app.get("/creators", verifyFireBaseToken, async (req, res) => {
      const cursor = creatorsCollection.find().sort({ createAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.patch("/creators/:id", async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status: status,
        },
      };

      const result = await creatorsCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    app.delete("/creators/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await creatorsCollection.deleteOne(query);
      res.send(result);
    });

    app.post("/creators", async (req, res) => {
      const creator = req.body;
      creator.status = "pending";
      creator.createAt = new Date();
      const email = creator.creatorEmail;

      const existingCreator = await creatorsCollection.findOne({
        creatorEmail: email,
      });
      if (existingCreator) {
        return res.status(404).send({ message: "creator exists" });
      }

      const result = await creatorsCollection.insertOne(creator);
      res.send(result);
    });

    //sent a ping to confirm
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // await client.close();
  }
};
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("prize arena server is running");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

// npm install cors
